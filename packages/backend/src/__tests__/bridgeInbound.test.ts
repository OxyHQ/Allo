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
import { TEST_BRIDGE_SECRET } from "./helpers/bridgeFixtures";

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

  beforeEach(async () => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SERVICE_URL = "http://bridge.test";
    mock = installMockMessaging();
    // Finding 3 gate: inbound `message` events require an ACTIVE linked account.
    // Seed one for the default owner so the existing creation tests still apply;
    // tests that exercise the gate's negative path delete it explicitly.
    await LinkedAccount.create({ userId: OWNER, network: "telegram", status: "active" });
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
    // beforeEach seeded an active link; reset it to pending_login so we can
    // observe session_status flipping it back to active (it is UNGATED).
    await LinkedAccount.findOneAndUpdate(
      { userId: OWNER, network: "telegram" },
      { $set: { status: "pending_login" } }
    );

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

  it("Fix 3: session_status with externalSelf persists the user's external identity", async () => {
    await handleEvent({
      v: 1,
      type: "session_status",
      network: "telegram",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
      sessionStatus: "active",
      externalSelf: { externalId: "123", username: "me", displayName: "Me", phoneHint: "+34•••12" },
    });

    const account = await LinkedAccount.findOne({ userId: OWNER, network: "telegram" });
    expect(account?.status).toBe("active");
    expect(account?.externalSelf?.externalId).toBe("123");
    expect(account?.externalSelf?.username).toBe("me");
    expect(account?.externalSelf?.displayName).toBe("Me");
    expect(account?.externalSelf?.phoneHint).toBe("+34•••12");
  });

  it("Fix 3: a later session_status WITHOUT externalSelf updates status but preserves externalSelf", async () => {
    // First an active event captures externalSelf.
    await handleEvent({
      v: 1,
      type: "session_status",
      network: "telegram",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
      sessionStatus: "active",
      externalSelf: { externalId: "123", username: "me" },
    });

    // Then an `expired` lifecycle event with NO externalSelf must not wipe it.
    await handleEvent({
      v: 1,
      type: "session_status",
      network: "telegram",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
      sessionStatus: "expired",
    });

    const account = await LinkedAccount.findOne({ userId: OWNER, network: "telegram" });
    expect(account?.status).toBe("expired");
    expect(account?.externalSelf?.externalId).toBe("123");
    expect(account?.externalSelf?.username).toBe("me");
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

  it("Finding 3: a 'message' event with NO active linked account materializes nothing", async () => {
    // Remove the active link seeded in beforeEach: a spoofed/leftover event must
    // not create a contact, conversation, or message.
    await LinkedAccount.deleteMany({ userId: OWNER, network: "telegram" });

    await handleEvent(messageEvent());

    expect(await Conversation.countDocuments({})).toBe(0);
    expect(await Message.countDocuments({})).toBe(0);
    expect(await ExternalContact.countDocuments({})).toBe(0);
  });

  it("Finding 3: an EXPIRED/REVOKED link is not 'active' and is also rejected", async () => {
    await LinkedAccount.findOneAndUpdate(
      { userId: OWNER, network: "telegram" },
      { $set: { status: "expired" } }
    );

    await handleEvent(messageEvent());

    expect(await Message.countDocuments({})).toBe(0);
    expect(await Conversation.countDocuments({})).toBe(0);
  });

  it("Finding 4: send_result whose network does not match the message is ignored", async () => {
    // Seed an owner-sent message to a telegram bridged conversation.
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
    await dispatchSend(message, conv); // sets external.network = telegram, bridgeStatus queued

    // A connector for a DIFFERENT network claims this message id.
    await handleEvent({
      v: 1,
      type: "send_result",
      network: "whatsapp",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
      messageId: String(message._id),
      status: "sent",
    });

    const after = await Message.findById(message._id);
    // Unchanged: still the queued status set by dispatchSend, not flipped to sent.
    expect(after?.external?.bridgeStatus).toBe("queued");
    expect(after?.external?.network).toBe("telegram");
  });

  it("Finding 4: send_result whose ownerUserId does not match the conversation is ignored", async () => {
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

    // Right network, WRONG owner.
    await handleEvent({
      v: 1,
      type: "send_result",
      network: "telegram",
      ownerUserId: "someone-else",
      externalChatId: EXTERNAL,
      messageId: String(message._id),
      status: "sent",
    });

    const after = await Message.findById(message._id);
    expect(after?.external?.bridgeStatus).toBe("queued");
  });

  it("Finding 4: a matching send_result still updates the message as before", async () => {
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

    const after = await Message.findById(message._id);
    expect(after?.external?.bridgeStatus).toBe("sent");
    expect(after?.external?.externalMessageId).toBe("tg-out-1");
  });

  it("Fix 4: a matching send_result atomically updates in place, preserves the subdoc, and emits the persisted state", async () => {
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

    const after = await Message.findById(message._id);
    expect(after?.external?.bridgeStatus).toBe("sent");
    expect(after?.external?.externalMessageId).toBe("tg-out-1");
    // The subdoc is preserved, not replaced — network stays intact.
    expect(after?.external?.network).toBe("telegram");

    const outbox = await BridgeOutbox.findOne({ messageId: String(message._id) });
    expect(outbox?.status).toBe("sent");

    // The emit reflects the PERSISTED state (the document returned by the atomic
    // update), so its payload carries the new bridgeStatus.
    const updates = mock.emitsOf("messageUpdated");
    const emitted = updates.find((e) => e.room === `conversation:${String(conv._id)}`);
    expect(emitted).toBeDefined();
    const payload = emitted?.payload as { external?: { bridgeStatus?: string } };
    expect(payload.external?.bridgeStatus).toBe("sent");
  });

  it("Fix 4: a mismatched-network send_result performs NO mutation, NO outbox update, NO emit", async () => {
    // Make the immediate dispatch fail (non-2xx) so the outbox stays `pending`,
    // giving an unambiguous baseline to prove the mismatched event doesn't flip it.
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 503 }));
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
    await dispatchSend(message, conv); // external.network = telegram, bridgeStatus = queued
    mock.emits.length = 0;

    await handleEvent({
      v: 1,
      type: "send_result",
      network: "whatsapp",
      ownerUserId: OWNER,
      externalChatId: EXTERNAL,
      messageId: String(message._id),
      status: "sent",
    });

    const after = await Message.findById(message._id);
    expect(after?.external?.bridgeStatus).toBe("queued");
    expect(after?.external?.network).toBe("telegram");

    // Outbox untouched (still pending) and no client notification went out.
    const outbox = await BridgeOutbox.findOne({ messageId: String(message._id) });
    expect(outbox?.status).toBe("pending");
    expect(mock.emitsOf("messageUpdated").length).toBe(0);
  });
});
