import { describe, expect, it, vi } from "vitest";

import type { PushPlatform } from "../../../config/push";
import type { PushDeliveryOutcome, PushSender } from "../../../services/push/delivery";
import { dispatchPushNotification } from "../../../services/push/dispatch";
import type { PushNotificationDevice, PushNotificationRequest } from "../../../services/push/notification";

/**
 * Routing a notification to the provider that owns each token, and turning the
 * outcomes into the two instructions the homeserver understands.
 *
 * The property under test everywhere below: a `rejected` pushkey is one the
 * provider said is permanently gone, and nothing else ever appears in that list.
 * Everything that might be our fault leaves the pusher alone and asks for a
 * retry instead.
 */

const ANDROID_APP_ID = "so.oxy.allo.android";
const IOS_APP_ID = "so.oxy.allo.ios";

const PLATFORM_BY_APP_ID: ReadonlyMap<string, PushPlatform> = new Map([
  [ANDROID_APP_ID, "android"],
  [IOS_APP_ID, "ios"],
]);

function device(appId: string, pushkey: string): PushNotificationDevice {
  return { appId, pushkey, fallback: undefined, sound: undefined };
}

function notificationFor(devices: readonly PushNotificationDevice[]): PushNotificationRequest {
  return {
    eventId: "$an-event-id",
    roomId: "!a-room:allo.you",
    unreadCount: 1,
    highPriority: true,
    devices,
  };
}

function senderReturning(
  platform: PushPlatform,
  outcomes: readonly PushDeliveryOutcome[],
): PushSender {
  return { platform, send: vi.fn(async () => outcomes) };
}

describe("routing by app id", () => {
  it("sends each device to the provider its app id names", async () => {
    const android = senderReturning("android", [{ kind: "delivered" }]);
    const ios = senderReturning("ios", [{ kind: "delivered" }]);
    const devices = [device(ANDROID_APP_ID, "aaa"), device(IOS_APP_ID, "bbb")];

    const result = await dispatchPushNotification(
      notificationFor(devices),
      new Map([
        ["android", android],
        ["ios", ios],
      ]),
      PLATFORM_BY_APP_ID,
    );

    expect(android.send).toHaveBeenCalledWith([devices[0]], expect.anything());
    expect(ios.send).toHaveBeenCalledWith([devices[1]], expect.anything());
    expect(result).toEqual({ rejected: [], hasTransientFailure: false });
  });

  it("batches the devices that share a provider into one call", async () => {
    const android = senderReturning("android", [{ kind: "delivered" }, { kind: "delivered" }]);
    const devices = [device(ANDROID_APP_ID, "aaa"), device(ANDROID_APP_ID, "bbb")];

    await dispatchPushNotification(
      notificationFor(devices),
      new Map([["android", android]]),
      PLATFORM_BY_APP_ID,
    );

    expect(android.send).toHaveBeenCalledTimes(1);
    expect(android.send).toHaveBeenCalledWith(devices, expect.anything());
  });

  it("rejects a pusher for an app id this deployment does not serve", async () => {
    const android = senderReturning("android", [{ kind: "delivered" }]);

    const result = await dispatchPushNotification(
      notificationFor([device(ANDROID_APP_ID, "aaa"), device("com.someone.else", "ccc")]),
      new Map([["android", android]]),
      PLATFORM_BY_APP_ID,
    );

    // There is no provider that could ever take it, so retrying forever is the
    // only other option.
    expect(result.rejected).toEqual(["ccc"]);
    expect(result.hasTransientFailure).toBe(false);
  });

  it("keeps the pusher when a platform has an app id but no sender behind it", async () => {
    const result = await dispatchPushNotification(
      notificationFor([device(IOS_APP_ID, "bbb")]),
      new Map(),
      PLATFORM_BY_APP_ID,
    );

    expect(result.rejected).toEqual([]);
    expect(result.hasTransientFailure).toBe(true);
  });
});

describe("what comes back to the homeserver", () => {
  it("lists only the pushkeys the provider called permanently gone", async () => {
    const android = senderReturning("android", [
      { kind: "delivered" },
      { kind: "rejected", reason: "messaging/registration-token-not-registered" },
      { kind: "failed", reason: "messaging/server-unavailable" },
    ]);

    const result = await dispatchPushNotification(
      notificationFor([
        device(ANDROID_APP_ID, "delivered-one"),
        device(ANDROID_APP_ID, "dead-one"),
        device(ANDROID_APP_ID, "flaky-one"),
      ]),
      new Map([["android", android]]),
      PLATFORM_BY_APP_ID,
    );

    expect(result.rejected).toEqual(["dead-one"]);
    expect(result.hasTransientFailure).toBe(true);
  });

  it("attributes an outcome to the device it belongs to inside one batch", async () => {
    /**
     * The failure this guards against is the worst one the gateway can produce:
     * a live phone deleted because a dead one two rows away failed. A sender
     * answers positionally, so the pairing has to survive every refactor of how
     * the batches are assembled.
     */
    const android = senderReturning("android", [
      { kind: "delivered" },
      { kind: "rejected", reason: "gone" },
    ]);

    const result = await dispatchPushNotification(
      notificationFor([device(ANDROID_APP_ID, "live-one"), device(ANDROID_APP_ID, "dead-one")]),
      new Map([["android", android]]),
      PLATFORM_BY_APP_ID,
    );

    expect(result.rejected).toEqual(["dead-one"]);
  });

  it("attributes an outcome to the device it belongs to, across providers", async () => {
    const android = senderReturning("android", [{ kind: "delivered" }]);
    const ios = senderReturning("ios", [{ kind: "rejected", reason: "Unregistered" }]);

    const result = await dispatchPushNotification(
      notificationFor([device(ANDROID_APP_ID, "android-token"), device(IOS_APP_ID, "ios-token")]),
      new Map([
        ["android", android],
        ["ios", ios],
      ]),
      PLATFORM_BY_APP_ID,
    );

    expect(result.rejected).toEqual(["ios-token"]);
  });

  it("names a pushkey once even if it arrives twice", async () => {
    const android = senderReturning("android", [
      { kind: "rejected", reason: "gone" },
      { kind: "rejected", reason: "gone" },
    ]);

    const result = await dispatchPushNotification(
      notificationFor([device(ANDROID_APP_ID, "aaa"), device(ANDROID_APP_ID, "aaa")]),
      new Map([["android", android]]),
      PLATFORM_BY_APP_ID,
    );

    expect(result.rejected).toEqual(["aaa"]);
  });

  it("keeps the pusher when a sender answers with fewer outcomes than devices", async () => {
    const android = senderReturning("android", [{ kind: "delivered" }]);

    const result = await dispatchPushNotification(
      notificationFor([device(ANDROID_APP_ID, "aaa"), device(ANDROID_APP_ID, "bbb")]),
      new Map([["android", android]]),
      PLATFORM_BY_APP_ID,
    );

    expect(result.rejected).toEqual([]);
    expect(result.hasTransientFailure).toBe(true);
  });
});
