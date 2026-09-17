import type { Message } from "firebase-admin/messaging";
import { describe, expect, it } from "vitest";

import type { PushDevice, PushNotification } from "../../../services/push/delivery";
import { createFcmSender, type FcmTransport, type FcmTransportResult } from "../../../services/push/fcm";

/**
 * Android delivery.
 *
 * Two things are being protected here. The first is what a notification says:
 * the words and the data are exactly what the caller handed over, so an
 * assertion on the payload is an assertion that nothing else can appear in it.
 * The second is the rejection mapping, which is the only place in the system
 * that can retire a live token.
 */

const DEVICE: PushDevice = { platform: "android", token: "device-token-aaa" };

const NOTIFICATION: PushNotification = {
  title: "Allo",
  body: "New message",
  data: { conversation_id: "conv-1", event_id: "evt-1" },
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
  it("carries the caller's words and data, and nothing else", async () => {
    const { transport, sent } = recordingTransport([delivered]);
    await createFcmSender(transport).send([DEVICE], NOTIFICATION);

    const message = sent[0]?.[0];
    expect(tokenOf(message)).toBe("device-token-aaa");
    expect(message?.data).toEqual({ conversation_id: "conv-1", event_id: "evt-1" });
    expect(message?.notification).toEqual({ title: "Allo", body: "New message" });
    expect(message?.android?.priority).toBe("high");
  });

  it("copies the data rather than sharing the caller's object", async () => {
    const { transport, sent } = recordingTransport([delivered]);
    await createFcmSender(transport).send([DEVICE], NOTIFICATION);

    expect(sent[0]?.[0]?.data).not.toBe(NOTIFICATION.data);
  });
});

describe("what FCM says about a token", () => {
  it("reports a delivered message as delivered", async () => {
    const { transport } = recordingTransport([delivered]);

    expect(await createFcmSender(transport).send([DEVICE], NOTIFICATION)).toEqual([
      { kind: "delivered" },
    ]);
  });

  it.each([
    "messaging/registration-token-not-registered",
    "messaging/invalid-registration-token",
    "messaging/invalid-recipient",
  ])("rejects the token when it is unambiguously gone (%s)", async (code) => {
    const { transport } = recordingTransport([failureWith(code)]);

    expect(await createFcmSender(transport).send([DEVICE], NOTIFICATION)).toEqual([
      { kind: "rejected", reason: code },
    ]);
  });

  it.each([
    /**
     * The two that look like rejections and are not. `invalid-argument` is
     * returned for a malformed *message* as well as a malformed token, and our
     * message is the same shape for every device — treating it as a dead token
     * would retire every token in the system over one of our own bugs.
     * `sender-id-mismatch` is a credential mistake on this side far more often
     * than a bad token.
     */
    "messaging/invalid-argument",
    "messaging/sender-id-mismatch",
    "messaging/server-unavailable",
    "messaging/internal-error",
    "messaging/quota-exceeded",
  ])("keeps the token for anything that might be our fault (%s)", async (code) => {
    const { transport } = recordingTransport([failureWith(code)]);

    expect(await createFcmSender(transport).send([DEVICE], NOTIFICATION)).toEqual([
      { kind: "failed", reason: code },
    ]);
  });

  it("keeps every token when the whole call fails", async () => {
    const transport: FcmTransport = async () => {
      throw new Error("FCM is unreachable");
    };

    expect(await createFcmSender(transport).send([DEVICE, DEVICE], NOTIFICATION)).toEqual([
      { kind: "failed", reason: "FCM is unreachable" },
      { kind: "failed", reason: "FCM is unreachable" },
    ]);
  });

  it("keeps every token when the results cannot be matched to the devices", async () => {
    const { transport } = recordingTransport([delivered]);

    const outcomes = await createFcmSender(transport).send(
      [DEVICE, { ...DEVICE, token: "device-token-bbb" }],
      NOTIFICATION,
    );

    expect(outcomes.every((outcome) => outcome.kind === "failed")).toBe(true);
  });

  it("answers in the order it was given the devices", async () => {
    const { transport } = recordingTransport([
      failureWith("messaging/registration-token-not-registered"),
      delivered,
    ]);

    const outcomes = await createFcmSender(transport).send(
      [DEVICE, { ...DEVICE, token: "device-token-bbb" }],
      NOTIFICATION,
    );

    expect(outcomes[0]?.kind).toBe("rejected");
    expect(outcomes[1]?.kind).toBe("delivered");
  });
});
