import { dispatchSend, processOutboxOnce } from "../services/BridgeService";
import { findOrCreateBridgedConversation } from "../services/BridgeInboundService";
import Message from "../models/Message";
import BridgeOutbox from "../models/BridgeOutbox";
import {
  BRIDGE_OUTBOX_MAX_ATTEMPTS,
  BRIDGE_OUTBOX_SWEEP_LIMIT,
  BRIDGE_REQUEST_TIMEOUT_MS,
  computeBackoffMs,
} from "../config/bridge";
import { installMockMessaging, type MockMessaging } from "./helpers/mockSocket";
import { TEST_BRIDGE_SECRET } from "./helpers/bridgeFixtures";
import { fetchWithTimeout } from "../utils/bridgeSigning";

const OWNER = "owner-1";
const EXTERNAL = "tg-out";

async function seedBridgedConversationAndMessage() {
  const conv = await findOrCreateBridgedConversation({
    network: "telegram",
    ownerUserId: OWNER,
    externalChatId: EXTERNAL,
    contact: { externalId: EXTERNAL },
  });
  const message = await Message.create({
    conversationId: String(conv._id),
    senderId: OWNER,
    senderDeviceId: 1,
    text: "outbound message",
    deliveredTo: [OWNER],
    encryptionVersion: 1,
  });
  return { conv, message };
}

describe("BridgeService outbox", () => {
  let mock: MockMessaging;
  const prevEnabled = process.env.BRIDGE_ENABLED;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  const prevUrl = process.env.BRIDGE_SERVICE_URL;

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SERVICE_URL = "http://bridge.test";
    mock = installMockMessaging();
  });

  afterEach(() => {
    mock.restore();
    jest.restoreAllMocks();
    process.env.BRIDGE_ENABLED = prevEnabled;
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
    process.env.BRIDGE_SERVICE_URL = prevUrl;
  });

  it("dispatchSend creates a pending outbox row and marks the message queued", async () => {
    // Immediate POST succeeds -> the row is marked sent on dispatch.
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    const { conv, message } = await seedBridgedConversationAndMessage();

    await dispatchSend(message, conv);

    const updatedMessage = await Message.findById(message._id);
    expect(updatedMessage?.external?.bridgeStatus).toBe("queued");
    expect(updatedMessage?.external?.network).toBe("telegram");

    const outbox = await BridgeOutbox.findOne({ messageId: String(message._id) });
    expect(outbox).not.toBeNull();
    // Immediate success path marks it sent.
    expect(outbox?.status).toBe("sent");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("processOutboxOnce backs off on failure and eventually fails permanently", async () => {
    // dispatchSend's immediate POST fails -> row stays pending at attempts 0.
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const { conv, message } = await seedBridgedConversationAndMessage();
    await dispatchSend(message, conv);

    let outbox = await BridgeOutbox.findOne({ messageId: String(message._id) });
    expect(outbox?.status).toBe("pending");
    expect(outbox?.attempts).toBe(0);

    // First sweep: attempts -> 1, still pending, nextAttemptAt advanced.
    const before = Date.now();
    await processOutboxOnce();
    outbox = await BridgeOutbox.findOne({ messageId: String(message._id) });
    expect(outbox?.attempts).toBe(1);
    expect(outbox?.status).toBe("pending");
    expect(outbox?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      before + computeBackoffMs(1) - 1000
    );

    // Drive sweeps until exhaustion, resetting nextAttemptAt to the past so each
    // tick is "due" (no real timers).
    for (let i = 0; i < BRIDGE_OUTBOX_MAX_ATTEMPTS + 2; i++) {
      await BridgeOutbox.updateOne(
        { messageId: String(message._id) },
        { $set: { nextAttemptAt: new Date(Date.now() - 1000) } }
      );
      await processOutboxOnce();
      const row = await BridgeOutbox.findOne({ messageId: String(message._id) });
      if (row?.status === "failed") break;
    }

    outbox = await BridgeOutbox.findOne({ messageId: String(message._id) });
    expect(outbox?.status).toBe("failed");

    const failedMessage = await Message.findById(message._id);
    expect(failedMessage?.external?.bridgeStatus).toBe("failed");

    const updates = mock.emitsOf("messageUpdated");
    expect(updates.some((e) => e.room === `conversation:${String(conv._id)}`)).toBe(true);
  });

  it("processOutboxOnce marks a row sent when the connector returns 200", async () => {
    // Immediate POST fails so the row is left pending, then a successful sweep.
    const fetchSpy = jest.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 500 })); // dispatch
    const { conv, message } = await seedBridgedConversationAndMessage();
    await dispatchSend(message, conv);

    let outbox = await BridgeOutbox.findOne({ messageId: String(message._id) });
    expect(outbox?.status).toBe("pending");

    fetchSpy.mockResolvedValue(new Response(null, { status: 200 })); // sweep
    await processOutboxOnce();

    outbox = await BridgeOutbox.findOne({ messageId: String(message._id) });
    expect(outbox?.status).toBe("sent");
  });

  it("processOutboxOnce processes at most BRIDGE_OUTBOX_SWEEP_LIMIT rows per pass", async () => {
    // Finding 5 (bound): with more due rows than the limit, a single pass marks
    // exactly the limit as sent and leaves the remainder pending for the next
    // tick — proving `.limit(BRIDGE_OUTBOX_SWEEP_LIMIT)` is applied.
    const fetchSpy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));

    const overflow = 5;
    const total = BRIDGE_OUTBOX_SWEEP_LIMIT + overflow;
    const past = new Date(Date.now() - 1000);
    const rows = Array.from({ length: total }, (_unused, i) => ({
      messageId: `m-${i}`,
      command: {
        v: 1 as const,
        type: "send" as const,
        network: "telegram" as const,
        ownerUserId: OWNER,
        externalChatId: EXTERNAL,
        messageId: `m-${i}`,
        text: `n${i}`,
      },
      status: "pending" as const,
      attempts: 0,
      nextAttemptAt: past,
    }));
    await BridgeOutbox.insertMany(rows);

    await processOutboxOnce();

    const sent = await BridgeOutbox.countDocuments({ status: "sent" });
    const pending = await BridgeOutbox.countDocuments({ status: "pending" });
    expect(sent).toBe(BRIDGE_OUTBOX_SWEEP_LIMIT);
    expect(pending).toBe(overflow);
    expect(fetchSpy).toHaveBeenCalledTimes(BRIDGE_OUTBOX_SWEEP_LIMIT);
  });

  it("fetchWithTimeout aborts a hung request after the timeout (the wiring postCommand relies on)", async () => {
    // Finding 5 (timeout): isolate the abort wiring with NO database involved so
    // fake timers are deterministic (faking timers around mongoose operations is
    // flaky). `postCommand`/`proxyToConnector` delegate to this exact helper, so
    // proving the helper aborts proves the hung-connector path is bounded.
    jest.useFakeTimers();
    try {
      let abortedReason: string | undefined;
      jest.spyOn(globalThis, "fetch").mockImplementation(
        (_input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (!signal) return; // a real hang: never settles without a signal
            signal.addEventListener("abort", () => {
              abortedReason = "aborted";
              reject(new DOMException("Aborted", "AbortError"));
            });
          })
      );

      const inflight = fetchWithTimeout(
        "http://bridge.test/commands",
        { method: "POST", body: "{}" },
        BRIDGE_REQUEST_TIMEOUT_MS
      );
      // Attach the rejection assertion BEFORE advancing timers so the catch
      // handler is registered when the abort fires (avoids an unhandled
      // rejection surfacing from inside the fake-timer callback).
      const assertion = expect(inflight).rejects.toMatchObject({ name: "AbortError" });
      // Nothing has aborted yet; advancing past the timeout fires the controller.
      await jest.advanceTimersByTimeAsync(BRIDGE_REQUEST_TIMEOUT_MS + 1);
      await assertion;
      expect(abortedReason).toBe("aborted");
    } finally {
      jest.useRealTimers();
    }
  });
});
