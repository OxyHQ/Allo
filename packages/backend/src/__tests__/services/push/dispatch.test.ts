import { describe, expect, it, vi } from "vitest";

import type { PushPlatform } from "../../../config/push";
import type {
  PushDeliveryOutcome,
  PushDevice,
  PushNotification,
  PushSender,
} from "../../../services/push/delivery";
import { sendPush } from "../../../services/push/dispatch";

/**
 * Routing a notification to the provider that owns each token, and turning the
 * outcomes into the two instructions the caller understands.
 *
 * The property under test everywhere below: a `rejected` token is one the
 * provider said is permanently gone, and nothing else ever appears in that list.
 * Everything that might be our fault leaves the token alone and asks for a
 * retry instead.
 */

const NOTIFICATION: PushNotification = {
  title: "Allo",
  body: "New message",
  data: { conversation_id: "conv-1" },
};

function device(platform: PushPlatform, token: string): PushDevice {
  return { platform, token };
}

function senderReturning(
  platform: PushPlatform,
  outcomes: readonly PushDeliveryOutcome[],
): PushSender {
  return { platform, send: vi.fn(async () => outcomes) };
}

describe("routing by platform", () => {
  it("sends each device to the provider its platform names", async () => {
    const android = senderReturning("android", [{ kind: "delivered" }]);
    const ios = senderReturning("ios", [{ kind: "delivered" }]);
    const devices = [device("android", "aaa"), device("ios", "bbb")];

    const result = await sendPush(
      devices,
      NOTIFICATION,
      new Map([
        ["android", android],
        ["ios", ios],
      ]),
    );

    expect(android.send).toHaveBeenCalledWith([devices[0]], NOTIFICATION);
    expect(ios.send).toHaveBeenCalledWith([devices[1]], NOTIFICATION);
    expect(result).toEqual({ rejected: [], hasTransientFailure: false });
  });

  it("batches the devices that share a provider into one call", async () => {
    const android = senderReturning("android", [{ kind: "delivered" }, { kind: "delivered" }]);
    const devices = [device("android", "aaa"), device("android", "bbb")];

    await sendPush(devices, NOTIFICATION, new Map([["android", android]]));

    expect(android.send).toHaveBeenCalledTimes(1);
    expect(android.send).toHaveBeenCalledWith(devices, NOTIFICATION);
  });

  it("keeps the token when a platform has no sender behind it", async () => {
    /**
     * A deployment without iOS credentials cannot reach an iOS device, and the
     * token is not at fault: gaining the credentials later must deliver to it.
     */
    const result = await sendPush([device("ios", "bbb")], NOTIFICATION, new Map());

    expect(result.rejected).toEqual([]);
    expect(result.hasTransientFailure).toBe(true);
  });

  it("does nothing for no devices", async () => {
    const android = senderReturning("android", []);

    const result = await sendPush([], NOTIFICATION, new Map([["android", android]]));

    expect(android.send).not.toHaveBeenCalled();
    expect(result).toEqual({ rejected: [], hasTransientFailure: false });
  });
});

describe("what comes back to the caller", () => {
  it("lists only the tokens the provider called permanently gone", async () => {
    const android = senderReturning("android", [
      { kind: "delivered" },
      { kind: "rejected", reason: "messaging/registration-token-not-registered" },
      { kind: "failed", reason: "messaging/server-unavailable" },
    ]);

    const result = await sendPush(
      [
        device("android", "delivered-one"),
        device("android", "dead-one"),
        device("android", "flaky-one"),
      ],
      NOTIFICATION,
      new Map([["android", android]]),
    );

    expect(result.rejected).toEqual(["dead-one"]);
    expect(result.hasTransientFailure).toBe(true);
  });

  it("attributes an outcome to the device it belongs to inside one batch", async () => {
    /**
     * The failure this guards against is the worst one this module can produce:
     * a live phone dropped because a dead one two rows away failed. A sender
     * answers positionally, so the pairing has to survive every refactor of how
     * the batches are assembled.
     */
    const android = senderReturning("android", [
      { kind: "delivered" },
      { kind: "rejected", reason: "gone" },
    ]);

    const result = await sendPush(
      [device("android", "live-one"), device("android", "dead-one")],
      NOTIFICATION,
      new Map([["android", android]]),
    );

    expect(result.rejected).toEqual(["dead-one"]);
  });

  it("attributes an outcome to the device it belongs to, across providers", async () => {
    const android = senderReturning("android", [{ kind: "delivered" }]);
    const ios = senderReturning("ios", [{ kind: "rejected", reason: "Unregistered" }]);

    const result = await sendPush(
      [device("android", "android-token"), device("ios", "ios-token")],
      NOTIFICATION,
      new Map([
        ["android", android],
        ["ios", ios],
      ]),
    );

    expect(result.rejected).toEqual(["ios-token"]);
  });

  it("names a token once even if it arrives twice", async () => {
    const android = senderReturning("android", [
      { kind: "rejected", reason: "gone" },
      { kind: "rejected", reason: "gone" },
    ]);

    const result = await sendPush(
      [device("android", "aaa"), device("android", "aaa")],
      NOTIFICATION,
      new Map([["android", android]]),
    );

    expect(result.rejected).toEqual(["aaa"]);
  });

  it("keeps the token when a sender answers with fewer outcomes than devices", async () => {
    const android = senderReturning("android", [{ kind: "delivered" }]);

    const result = await sendPush(
      [device("android", "aaa"), device("android", "bbb")],
      NOTIFICATION,
      new Map([["android", android]]),
    );

    expect(result.rejected).toEqual([]);
    expect(result.hasTransientFailure).toBe(true);
  });
});
