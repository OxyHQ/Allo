import { describe, expect, it } from "vitest";

import {
  MAXIMUM_DEVICES_PER_NOTIFICATION,
  parsePushNotification,
  plaintextFieldsPresent,
} from "../../../services/push/notification";

/**
 * What Synapse posts, and what this gateway is willing to see of it.
 *
 * The load-bearing case is the last group: a notification that arrives carrying
 * message plaintext must not be able to hand that plaintext to anything
 * downstream. The parser strips it, which is stronger than refusing it — there
 * is nothing left to leak by the time any sender runs.
 */

function notification(overrides: Record<string, unknown> = {}): unknown {
  return {
    notification: {
      event_id: "$an-event-id",
      room_id: "!a-room:allo.you",
      counts: { unread: 3 },
      prio: "high",
      devices: [{ app_id: "so.oxy.allo.android", pushkey: "device-token-aaa" }],
      ...overrides,
    },
  };
}

describe("a well-formed notification", () => {
  it("is read into the shape the senders take", () => {
    const parsed = parsePushNotification(notification());

    expect(parsed).toEqual({
      eventId: "$an-event-id",
      roomId: "!a-room:allo.you",
      unreadCount: 3,
      highPriority: true,
      devices: [
        {
          appId: "so.oxy.allo.android",
          pushkey: "device-token-aaa",
          fallback: undefined,
          sound: undefined,
        },
      ],
    });
  });

  it("carries the words the client registered, so the phone speaks its language", () => {
    const parsed = parsePushNotification(
      notification({
        devices: [
          {
            app_id: "so.oxy.allo.android",
            pushkey: "device-token-aaa",
            data: { default_payload: { title: "Allo", body: "Nuevo mensaje" } },
            tweaks: { sound: "default" },
          },
        ],
      }),
    );

    expect(parsed?.devices[0]?.fallback).toEqual({ title: "Allo", body: "Nuevo mensaje" });
    expect(parsed?.devices[0]?.sound).toBe("default");
  });

  it("reads a default_payload that arrived as a JSON string, which is what web sends", () => {
    const parsed = parsePushNotification(
      notification({
        devices: [
          {
            app_id: "so.oxy.allo.android",
            pushkey: "device-token-aaa",
            data: { default_payload: JSON.stringify({ title: "Allo", body: "Nuovo messaggio" }) },
          },
        ],
      }),
    );

    // The Rust binding parses the string before it reaches the homeserver and
    // `matrix-js-sdk` does not, so the same registration arrives in two shapes.
    expect(parsed?.devices[0]?.fallback).toEqual({ title: "Allo", body: "Nuovo messaggio" });
  });

  it("keeps a malformed default_payload from costing the notification", () => {
    const parsed = parsePushNotification(
      notification({
        devices: [
          {
            app_id: "so.oxy.allo.android",
            pushkey: "device-token-aaa",
            data: { default_payload: { title: 7 } },
          },
        ],
      }),
    );

    expect(parsed?.devices).toHaveLength(1);
    expect(parsed?.devices[0]?.fallback).toBeUndefined();
  });

  it("reads a counts-only notification, which has no event and is not malformed", () => {
    const parsed = parsePushNotification({
      notification: {
        counts: { unread: 0 },
        devices: [{ app_id: "so.oxy.allo.ios", pushkey: "device-token-bbb" }],
      },
    });

    expect(parsed?.eventId).toBeUndefined();
    expect(parsed?.unreadCount).toBe(0);
    expect(parsed?.devices).toHaveLength(1);
  });

  it("treats an unstated priority as high, because a message should not wait", () => {
    expect(parsePushNotification(notification({ prio: undefined }))?.highPriority).toBe(true);
    expect(parsePushNotification(notification({ prio: "low" }))?.highPriority).toBe(false);
  });
});

describe("a malformed notification", () => {
  it.each([
    ["nothing at all", undefined],
    ["not an object", "notify me"],
    ["no notification key", {}],
    ["no devices", { notification: { event_id: "$e" } }],
    ["an empty device list", { notification: { devices: [] } }],
    ["a device with no pushkey", { notification: { devices: [{ app_id: "so.oxy.allo.android" }] } }],
    ["a device with no app id", { notification: { devices: [{ pushkey: "device-token" }] } }],
  ])("is refused: %s", (_description, payload) => {
    expect(parsePushNotification(payload)).toBeUndefined();
  });

  it("is refused when one device in a list is malformed, rather than partly accepted", () => {
    const payload = notification({
      devices: [
        { app_id: "so.oxy.allo.android", pushkey: "device-token-aaa" },
        { app_id: "so.oxy.allo.android" },
      ],
    });

    expect(parsePushNotification(payload)).toBeUndefined();
  });

  it("is refused when it names more devices than one request may", () => {
    const devices = Array.from({ length: MAXIMUM_DEVICES_PER_NOTIFICATION + 1 }, (_, index) => ({
      app_id: "so.oxy.allo.android",
      pushkey: `device-token-${index}`,
    }));

    expect(parsePushNotification(notification({ devices }))).toBeUndefined();
  });
});

describe("message plaintext", () => {
  const withContent = notification({
    sender: "@ana:allo.you",
    sender_display_name: "Ana",
    room_name: "Familia",
    content: { msgtype: "m.text", body: "the actual message" },
  });

  it("is stripped, so nothing downstream can read it even by accident", () => {
    const parsed = parsePushNotification(withContent);

    expect(parsed).toBeDefined();
    expect(JSON.stringify(parsed)).not.toContain("the actual message");
    expect(JSON.stringify(parsed)).not.toContain("Ana");
    expect(JSON.stringify(parsed)).not.toContain("Familia");
  });

  it("cannot reach a sender, because the parsed shape has exactly these fields", () => {
    /**
     * The assertion is on the KEYS and not on their values, because the mistake
     * this catches is not a wrong value: it is somebody widening the result — a
     * spread of the parsed notification, a field added "just for logging" — and
     * every plaintext field arriving with it. Naming the whole set means such a
     * change has to come here and say so.
     */
    const parsed = parsePushNotification(withContent);

    expect(Object.keys(parsed ?? {}).sort()).toEqual([
      "devices",
      "eventId",
      "highPriority",
      "roomId",
      "unreadCount",
    ]);
    expect(Object.keys(parsed?.devices[0] ?? {}).sort()).toEqual([
      "appId",
      "fallback",
      "pushkey",
      "sound",
    ]);
  });

  it("is reported by name, because its arrival means a pusher has the wrong format", () => {
    expect(plaintextFieldsPresent(withContent)).toEqual([
      "content",
      "sender",
      "sender_display_name",
      "room_name",
    ]);
  });

  it("is not reported when the notification is the event_id_only shape it should be", () => {
    expect(plaintextFieldsPresent(notification())).toEqual([]);
  });

  it("is not reported for something that is not a notification at all", () => {
    expect(plaintextFieldsPresent(undefined)).toEqual([]);
    expect(plaintextFieldsPresent("a string")).toEqual([]);
    expect(plaintextFieldsPresent({ notification: null })).toEqual([]);
  });
});
