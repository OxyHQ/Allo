import type { Message } from "firebase-admin/messaging";
import { describe, expect, it } from "vitest";

import { createFcmSender, type FcmTransport, type FcmTransportResult } from "../../../services/push/fcm";
import type { PushNotificationDevice, PushNotificationRequest } from "../../../services/push/notification";

/**
 * Android delivery.
 *
 * Two things are being protected here. The first is what a notification says:
 * the words come from the client and the message never does, so an assertion on
 * the payload is an assertion that plaintext cannot appear in it. The second is
 * the rejection mapping, which is the only place in the system that can delete a
 * live pusher.
 */

const DEVICE: PushNotificationDevice = {
  appId: "so.oxy.allo.android",
  pushkey: "device-token-aaa",
  fallback: undefined,
  sound: undefined,
};

const ALERT: PushNotificationRequest = {
  eventId: "$an-event-id",
  roomId: "!a-room:allo.you",
  unreadCount: 3,
  highPriority: true,
  devices: [DEVICE],
};

function recordingTransport(results: readonly FcmTransportResult[]): {
  transport: FcmTransport;
  sent: Message[][];
} {
  const sent: Message[][] = [];
  return {
    sent,
    transport: async (messages) => {
      sent.push([...messages]);
      return results;
    },
  };
}

const delivered: FcmTransportResult = { success: true, code: undefined, message: undefined };

function failureWith(code: string): FcmTransportResult {
  return { success: false, code, message: "as reported by FCM" };
}

function tokenOf(message: Message | undefined): string | undefined {
  return message !== undefined && "token" in message ? message.token : undefined;
}

describe("the message FCM is given", () => {
  it("carries the event coordinates and the client's own words", async () => {
    const { transport, sent } = recordingTransport([delivered]);
    await createFcmSender(transport).send(
      [{ ...DEVICE, fallback: { title: "Allo", body: "Nuevo mensaje" } }],
      ALERT,
    );

    const message = sent[0]?.[0];
    expect(tokenOf(message)).toBe("device-token-aaa");
    expect(message?.data).toEqual({
      event_id: "$an-event-id",
      room_id: "!a-room:allo.you",
      unread_count: "3",
    });
    expect(message?.notification).toEqual({ title: "Allo", body: "Nuevo mensaje" });
  });

  it("falls back to built-in words when the client registered none", async () => {
    const { transport, sent } = recordingTransport([delivered]);
    await createFcmSender(transport).send([DEVICE], ALERT);

    expect(sent[0]?.[0]?.notification).toEqual({ title: "Allo", body: "New message" });
  });

  it("collapses on the event, so a retry replaces the first attempt", async () => {
    const { transport, sent } = recordingTransport([delivered]);
    await createFcmSender(transport).send([DEVICE], ALERT);

    expect(sent[0]?.[0]?.android?.collapseKey).toBe("$an-event-id");
    expect(sent[0]?.[0]?.android?.priority).toBe("high");
  });

  it("shows nothing for a counts-only notification, which announces no new message", async () => {
    const { transport, sent } = recordingTransport([delivered]);
    await createFcmSender(transport).send([DEVICE], {
      eventId: undefined,
      roomId: undefined,
      unreadCount: 0,
      highPriority: false,
      devices: [DEVICE],
    });

    const message = sent[0]?.[0];
    expect(message?.notification).toBeUndefined();
    expect(message?.data).toEqual({ unread_count: "0" });
    expect(message?.android?.priority).toBe("normal");
  });
});

describe("what FCM says about a token", () => {
  it("reports a delivered message as delivered", async () => {
    const { transport } = recordingTransport([delivered]);

    expect(await createFcmSender(transport).send([DEVICE], ALERT)).toEqual([
      { kind: "delivered" },
    ]);
  });

  it.each([
    "messaging/registration-token-not-registered",
    "messaging/invalid-registration-token",
    "messaging/invalid-recipient",
  ])("rejects the pusher when the token is unambiguously gone (%s)", async (code) => {
    const { transport } = recordingTransport([failureWith(code)]);

    expect(await createFcmSender(transport).send([DEVICE], ALERT)).toEqual([
      { kind: "rejected", reason: code },
    ]);
  });

  it.each([
    /**
     * The two that look like rejections and are not. `invalid-argument` is
     * returned for a malformed *message* as well as a malformed token, and our
     * message is the same shape for every device — treating it as a dead token
     * would delete every pusher in the system over one of our own bugs.
     * `sender-id-mismatch` is a credential mistake on this side far more often
     * than a bad token.
     */
    "messaging/invalid-argument",
    "messaging/sender-id-mismatch",
    "messaging/server-unavailable",
    "messaging/internal-error",
    "messaging/quota-exceeded",
  ])("keeps the pusher for anything that might be our fault (%s)", async (code) => {
    const { transport } = recordingTransport([failureWith(code)]);

    expect(await createFcmSender(transport).send([DEVICE], ALERT)).toEqual([
      { kind: "failed", reason: code },
    ]);
  });

  it("keeps every pusher when the whole call fails", async () => {
    const transport: FcmTransport = async () => {
      throw new Error("FCM is unreachable");
    };

    expect(await createFcmSender(transport).send([DEVICE, DEVICE], ALERT)).toEqual([
      { kind: "failed", reason: "FCM is unreachable" },
      { kind: "failed", reason: "FCM is unreachable" },
    ]);
  });

  it("keeps every pusher when the results cannot be matched to the devices", async () => {
    const { transport } = recordingTransport([delivered]);

    const outcomes = await createFcmSender(transport).send(
      [DEVICE, { ...DEVICE, pushkey: "device-token-bbb" }],
      ALERT,
    );

    expect(outcomes.every((outcome) => outcome.kind === "failed")).toBe(true);
  });

  it("answers in the order it was given the devices", async () => {
    const { transport } = recordingTransport([
      failureWith("messaging/registration-token-not-registered"),
      delivered,
    ]);

    const outcomes = await createFcmSender(transport).send(
      [DEVICE, { ...DEVICE, pushkey: "device-token-bbb" }],
      ALERT,
    );

    expect(outcomes[0]?.kind).toBe("rejected");
    expect(outcomes[1]?.kind).toBe("delivered");
  });
});
