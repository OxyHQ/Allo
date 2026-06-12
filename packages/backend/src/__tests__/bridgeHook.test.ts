import request from "supertest";
import { buildApp } from "./testApp";
import { installMockMessaging, type MockMessaging } from "./helpers/mockSocket";
import messagesRoutes from "../routes/messages";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import Device from "../models/Device";
import BridgeOutbox from "../models/BridgeOutbox";
import { TEST_BRIDGE_SECRET } from "./helpers/bridgeFixtures";

const OWNER = "owner-1";
const PEER = "peer-1";
const EXTERNAL = "tg-hook";

function makeApp() {
  return buildApp({
    injectUserId: OWNER,
    mount: [{ path: "/api/messages", router: messagesRoutes }],
  });
}

async function seedBridgedConversation() {
  return Conversation.create({
    type: "direct",
    participants: [{ userId: OWNER, role: "admin", joinedAt: new Date() }],
    externalParticipants: [{ network: "telegram", externalId: EXTERNAL, displayName: "Alice" }],
    bridge: { network: "telegram", ownerUserId: OWNER, externalChatId: EXTERNAL },
    createdBy: OWNER,
    unreadCounts: {},
  });
}

async function seedNativeConversation() {
  return Conversation.create({
    type: "direct",
    participants: [
      { userId: OWNER, role: "admin", joinedAt: new Date() },
      { userId: PEER, role: "member", joinedAt: new Date() },
    ],
    createdBy: OWNER,
    unreadCounts: {},
  });
}

describe("Bridge dispatch hook in POST /api/messages", () => {
  let mock: MockMessaging;
  const prevEnabled = process.env.BRIDGE_ENABLED;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  const prevUrl = process.env.BRIDGE_SERVICE_URL;

  beforeEach(() => {
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SERVICE_URL = "http://bridge.test";
    mock = installMockMessaging();
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    mock.restore();
    jest.restoreAllMocks();
    process.env.BRIDGE_ENABLED = prevEnabled;
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
    process.env.BRIDGE_SERVICE_URL = prevUrl;
  });

  it("flag ON + bridged conversation: creates a BridgeOutbox row", async () => {
    process.env.BRIDGE_ENABLED = "true";
    const conv = await seedBridgedConversation();

    const res = await request(makeApp())
      .post("/api/messages")
      .send({ conversationId: String(conv._id), senderDeviceId: 1, text: "hello telegram" });

    expect(res.status).toBe(201);
    // dispatchSend runs asynchronously (void); give the microtask queue a turn.
    await new Promise((resolve) => setImmediate(resolve));

    const outboxCount = await BridgeOutbox.countDocuments({});
    expect(outboxCount).toBe(1);
  });

  it("flag ON + NON-bridged conversation: creates NO BridgeOutbox row", async () => {
    process.env.BRIDGE_ENABLED = "true";
    const conv = await seedNativeConversation();

    const res = await request(makeApp())
      .post("/api/messages")
      .send({ conversationId: String(conv._id), senderDeviceId: 1, text: "hello native" });

    expect(res.status).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));

    const outboxCount = await BridgeOutbox.countDocuments({});
    expect(outboxCount).toBe(0);
  });

  it("flag OFF + bridged conversation: creates NO BridgeOutbox row", async () => {
    delete process.env.BRIDGE_ENABLED;
    const conv = await seedBridgedConversation();

    const res = await request(makeApp())
      .post("/api/messages")
      .send({ conversationId: String(conv._id), senderDeviceId: 1, text: "hello telegram" });

    expect(res.status).toBe(201);
    await new Promise((resolve) => setImmediate(resolve));

    const outboxCount = await BridgeOutbox.countDocuments({});
    expect(outboxCount).toBe(0);
  });
});

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

function wireCiphertext(n: number): string {
  return b64({
    v: 2,
    dh: Buffer.from("dh-public-key-bytes").toString("base64"),
    pn: 0,
    n,
    ct: Buffer.from(`nonce-and-aead-${n}`).toString("base64"),
  });
}

async function registerDevice(userId: string, deviceId: number) {
  return Device.create({
    userId,
    deviceId,
    identityKeyPublic: "idkey",
    signedPreKey: { keyId: 1, publicKey: "spk", signature: "sig" },
    preKeys: [],
    registrationId: 1000 + deviceId,
    lastSeen: new Date(),
  });
}

describe("Finding 7: v3 envelopes are rejected for bridged conversations", () => {
  let mock: MockMessaging;
  const prevEnabled = process.env.BRIDGE_ENABLED;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  const prevUrl = process.env.BRIDGE_SERVICE_URL;

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SERVICE_URL = "http://bridge.test";
    mock = installMockMessaging();
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    mock.restore();
    jest.restoreAllMocks();
    process.env.BRIDGE_ENABLED = prevEnabled;
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
    process.env.BRIDGE_SERVICE_URL = prevUrl;
  });

  it("flag ON: a v3 envelope to a BRIDGED conversation is 400 and persists nothing", async () => {
    const conv = await seedBridgedConversation();
    // A plausible envelope payload (targeting some device) — it must be rejected
    // BEFORE any device-list/persist logic because the conversation is bridged.
    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conv._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        messageType: "text",
        envelopes: [
          { recipientUserId: OWNER, recipientDeviceId: 2, ciphertext: wireCiphertext(1) },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(
      "Encrypted messages are not supported for bridged conversations"
    );
    // Nothing persisted: no Message, no BridgeOutbox.
    expect(await Message.countDocuments({})).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await BridgeOutbox.countDocuments({})).toBe(0);
  });

  it("flag ON: a v3 envelope to a NON-bridged conversation still succeeds (regression)", async () => {
    const conv = await Conversation.create({
      type: "direct",
      participants: [
        { userId: OWNER, role: "admin", joinedAt: new Date() },
        { userId: PEER, role: "member", joinedAt: new Date() },
      ],
      createdBy: OWNER,
      unreadCounts: {},
    });
    await registerDevice(OWNER, 1);
    await registerDevice(OWNER, 2);
    await registerDevice(PEER, 1);

    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conv._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        messageType: "text",
        envelopes: [
          { recipientUserId: OWNER, recipientDeviceId: 2, ciphertext: wireCiphertext(1) },
          { recipientUserId: PEER, recipientDeviceId: 1, ciphertext: wireCiphertext(2) },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.encryptionVersion).toBe(3);
    expect(await Message.countDocuments({})).toBe(1);
  });
});
