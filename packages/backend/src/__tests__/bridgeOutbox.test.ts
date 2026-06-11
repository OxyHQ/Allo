import { dispatchSend, processOutboxOnce } from "../services/BridgeService";
import { findOrCreateBridgedConversation } from "../services/BridgeInboundService";
import Message from "../models/Message";
import BridgeOutbox from "../models/BridgeOutbox";
import { BRIDGE_OUTBOX_MAX_ATTEMPTS, computeBackoffMs } from "../config/bridge";
import { installMockMessaging, type MockMessaging } from "./helpers/mockSocket";

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
    process.env.BRIDGE_SHARED_SECRET = "s3cr3t";
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
});
