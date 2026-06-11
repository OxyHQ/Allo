import type { BridgeEvent } from "@allo/shared-types";
import {
  handleEvent,
  findOrCreateBridgedConversation,
} from "../services/BridgeInboundService";
import { dispatchSend } from "../services/BridgeService";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import ExternalContact from "../models/ExternalContact";
import LinkedAccount from "../models/LinkedAccount";
import BridgeOutbox from "../models/BridgeOutbox";
import { installMockMessaging, type MockMessaging } from "./helpers/mockSocket";

const OWNER = "owner-1";
const EXTERNAL = "tg-123";

function messageEvent(overrides: Partial<BridgeEvent> = {}): BridgeEvent {
  return {
    v: 1,
    type: "message",
    network: "telegram",
    ownerUserId: OWNER,
    externalChatId: EXTERNAL,
    externalSenderId: EXTERNAL,
    externalMessageId: "tg-msg-1",
    text: "hello from telegram",
    senderDisplayName: "Alice",
    senderUsername: "alice_tg",
    ...overrides,
  };
}

describe("BridgeInboundService", () => {
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

  it("creates a bridged conversation, the contact, and a plaintext message from a 'message' event", async () => {
    await handleEvent(messageEvent());

    const conv = await Conversation.findOne({ "bridge.externalChatId": EXTERNAL });
    expect(conv).not.toBeNull();
    expect(conv?.bridge).toMatchObject({
      network: "telegram",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
    });
    expect(conv?.type).toBe("direct");
    expect(conv?.participants).toHaveLength(1);
    expect(conv?.participants[0].userId).toBe(OWNER);
    expect(conv?.externalParticipants).toHaveLength(1);

    const contact = await ExternalContact.findOne({ ownerUserId: OWNER, externalId: EXTERNAL });
    expect(contact?.displayName).toBe("Alice");

    const msg = await Message.findOne({ conversationId: String(conv?._id) });
    expect(msg?.senderId).toBe("ext:telegram:tg-123");
    expect(msg?.senderDeviceId).toBe(0);
    expect(msg?.text).toBe("hello from telegram");
    expect(msg?.external?.externalMessageId).toBe("tg-msg-1");

    const uc = conv?.unreadCounts as Map<string, number>;
    expect(uc.get(OWNER)).toBe(1);
  });

  it("emits newMessage to the conversation room AND the owner's user room", async () => {
    await handleEvent(messageEvent());
    const conv = await Conversation.findOne({ "bridge.externalChatId": EXTERNAL });
    const convId = String(conv?._id);

    const newMessages = mock.emitsOf("newMessage");
    expect(newMessages.some((e) => e.room === `conversation:${convId}`)).toBe(true);
    expect(newMessages.some((e) => e.room === `user:${OWNER}`)).toBe(true);
  });

  it("dedups replays of the same external message (exactly one message)", async () => {
    await handleEvent(messageEvent());
    await handleEvent(messageEvent());

    const count = await Message.countDocuments({ "external.externalMessageId": "tg-msg-1" });
    expect(count).toBe(1);

    const conv = await Conversation.findOne({ "bridge.externalChatId": EXTERNAL });
    const uc = conv?.unreadCounts as Map<string, number>;
    expect(uc.get(OWNER)).toBe(1);
  });

  it("increments unread to 2 after a second distinct message", async () => {
    await handleEvent(messageEvent({ externalMessageId: "tg-msg-1" }));
    await handleEvent(messageEvent({ externalMessageId: "tg-msg-2", text: "second" }));

    const conv = await Conversation.findOne({ "bridge.externalChatId": EXTERNAL });
    const uc = conv?.unreadCounts as Map<string, number>;
    expect(uc.get(OWNER)).toBe(2);
  });

  it("findOrCreateBridgedConversation is idempotent (same _id on repeat calls)", async () => {
    const first = await findOrCreateBridgedConversation({
      network: "telegram",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
      contact: { externalId: EXTERNAL, displayName: "Alice" },
    });
    const second = await findOrCreateBridgedConversation({
      network: "telegram",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
    });
    expect(String(first._id)).toBe(String(second._id));
    const count = await Conversation.countDocuments({ "bridge.externalChatId": EXTERNAL });
    expect(count).toBe(1);
  });

  it("send_result marks the message external.bridgeStatus and outbox, then emits messageUpdated", async () => {
    // Seed a bridged conversation + an owner-sent message via dispatchSend so an
    // outbox row + message.external exist to correlate.
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
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
      text: "outbound hi",
      deliveredTo: [OWNER],
      encryptionVersion: 1,
    });
    await dispatchSend(message, conv);
    mock.emits.length = 0; // clear emits from dispatch

    await handleEvent({
      v: 1,
      type: "send_result",
      network: "telegram",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
      messageId: String(message._id),
      status: "sent",
      externalMessageId: "tg-out-1",
    });

    const updated = await Message.findById(message._id);
    expect(updated?.external?.bridgeStatus).toBe("sent");
    expect(updated?.external?.externalMessageId).toBe("tg-out-1");
    expect(updated?.external?.network).toBe("telegram");

    const outbox = await BridgeOutbox.findOne({ messageId: String(message._id) });
    expect(outbox?.status).toBe("sent");

    const updates = mock.emitsOf("messageUpdated");
    expect(updates.some((e) => e.room === `conversation:${String(conv._id)}`)).toBe(true);
  });

  it("session_status updates the LinkedAccount status", async () => {
    await LinkedAccount.create({ userId: OWNER, network: "telegram", status: "pending_login" });

    await handleEvent({
      v: 1,
      type: "session_status",
      network: "telegram",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
      sessionStatus: "active",
    });

    const account = await LinkedAccount.findOne({ userId: OWNER, network: "telegram" });
    expect(account?.status).toBe("active");
  });

  it("edit updates message text and emits messageUpdated", async () => {
    await handleEvent(messageEvent());
    await handleEvent({
      v: 1,
      type: "edit",
      network: "telegram",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
      externalMessageId: "tg-msg-1",
      text: "edited text",
    });

    const msg = await Message.findOne({ "external.externalMessageId": "tg-msg-1" });
    expect(msg?.text).toBe("edited text");
    expect(msg?.editedAt).toBeInstanceOf(Date);
    expect(mock.emitsOf("messageUpdated").length).toBeGreaterThan(0);
  });

  it("delete tombstones the message and emits messageDeleted", async () => {
    await handleEvent(messageEvent());
    await handleEvent({
      v: 1,
      type: "delete",
      network: "telegram",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
      externalMessageId: "tg-msg-1",
    });

    const msg = await Message.findOne({ "external.externalMessageId": "tg-msg-1" });
    expect(msg?.deletedAt).toBeInstanceOf(Date);
    expect(msg?.text).toBeUndefined();
    const deletes = mock.emitsOf("messageDeleted");
    expect(deletes.length).toBeGreaterThan(0);
    expect(deletes[0].payload).toMatchObject({ scope: "everyone" });
  });
});
