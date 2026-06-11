import request from "supertest";
import { buildApp } from "./testApp";
import { installMockMessaging, type MockMessaging } from "./helpers/mockSocket";
import messagesRoutes from "../routes/messages";
import Conversation from "../models/Conversation";
import BridgeOutbox from "../models/BridgeOutbox";

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
    process.env.BRIDGE_SHARED_SECRET = "s3cr3t";
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
