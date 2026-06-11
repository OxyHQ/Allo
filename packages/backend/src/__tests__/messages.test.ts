import request from "supertest";
import { buildApp } from "./testApp";
import messagesRoutes from "../routes/messages";
import conversationsRoutes from "../routes/conversations";
import Conversation from "../models/Conversation";
import Message from "../models/Message";

const USER_ID = "u1";
const PEER_ID = "u2";

function makeApp() {
  return buildApp({
    injectUserId: USER_ID,
    mount: [
      { path: "/api/messages", router: messagesRoutes },
      { path: "/api/conversations", router: conversationsRoutes },
    ],
  });
}

async function createDirectConversation() {
  return Conversation.create({
    type: "direct",
    participants: [
      { userId: USER_ID, role: "admin", joinedAt: new Date() },
      { userId: PEER_ID, role: "member", joinedAt: new Date() },
    ],
    createdBy: USER_ID,
    unreadCounts: {},
  });
}

describe("POST /api/messages", () => {
  it("rejects a message without conversationId", async () => {
    const res = await request(makeApp())
      .post("/api/messages")
      .send({ senderDeviceId: 1, text: "hola" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Bad Request");
    expect(res.body.message).toContain("conversationId");
  });

  it("rejects a message without senderDeviceId", async () => {
    const conversation = await createDirectConversation();
    const res = await request(makeApp())
      .post("/api/messages")
      .send({ conversationId: String(conversation._id), text: "hola" });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("senderDeviceId");
  });

  it("creates a plaintext message and updates the conversation preview", async () => {
    const conversation = await createDirectConversation();
    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        text: "hola mundo",
      });

    expect(res.status).toBe(201);
    expect(res.body.data.text).toBe("hola mundo");
    expect(res.body.data.senderId).toBe(USER_ID);

    const updated = await Conversation.findById(conversation._id);
    expect(updated?.lastMessage?.text).toBe("hola mundo");
    expect(updated?.unreadCounts.get(PEER_ID)).toBe(1);
    expect(updated?.unreadCounts.get(USER_ID) ?? 0).toBe(0);
  });

  it("rejects a malformed encrypted v2 payload", async () => {
    const conversation = await createDirectConversation();
    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        ciphertext: "not-valid-base64-json!!!",
        encryptionVersion: 2,
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Malformed");
  });
});

describe("DELETE /api/messages/:id/reactions/:emoji", () => {
  it("removes the user's reaction for the emoji", async () => {
    const conversation = await createDirectConversation();
    const message = await Message.create({
      conversationId: String(conversation._id),
      senderId: PEER_ID,
      senderDeviceId: 1,
      text: "react to me",
      deliveredTo: [PEER_ID],
      reactions: { "👍": [USER_ID, PEER_ID] },
    });

    const res = await request(makeApp()).delete(
      `/api/messages/${message._id}/reactions/${encodeURIComponent("👍")}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.hasReacted).toBe(false);
    expect(res.body.data.reactions["👍"]).toEqual([PEER_ID]);

    const persisted = await Message.findById(message._id);
    const reactions = persisted?.reactions as unknown as Map<string, string[]>;
    expect(reactions.get("👍")).toEqual([PEER_ID]);
  });

  it("removes the emoji key entirely when the user was the only reactor", async () => {
    const conversation = await createDirectConversation();
    const message = await Message.create({
      conversationId: String(conversation._id),
      senderId: PEER_ID,
      senderDeviceId: 1,
      text: "react to me",
      deliveredTo: [PEER_ID],
      reactions: { "❤️": [USER_ID] },
    });

    const res = await request(makeApp()).delete(
      `/api/messages/${message._id}/reactions/${encodeURIComponent("❤️")}`
    );

    expect(res.status).toBe(200);
    expect(res.body.data.reactions["❤️"]).toBeUndefined();
  });

  it("returns 404 for an unknown message", async () => {
    const res = await request(makeApp()).delete(
      `/api/messages/000000000000000000000000/reactions/${encodeURIComponent("👍")}`
    );
    expect(res.status).toBe(404);
  });
});

describe("GET /api/messages", () => {
  it("requires conversationId", async () => {
    const res = await request(makeApp()).get("/api/messages");
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("conversationId");
  });

  it("returns messages for a conversation the user belongs to", async () => {
    const conversation = await createDirectConversation();
    await Message.create({
      conversationId: String(conversation._id),
      senderId: PEER_ID,
      senderDeviceId: 1,
      text: "first",
      deliveredTo: [PEER_ID],
    });

    const res = await request(makeApp())
      .get("/api/messages")
      .query({ conversationId: String(conversation._id) });

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(1);
    expect(res.body.data.messages[0].text).toBe("first");
  });
});

describe("GET /api/conversations", () => {
  it("returns an empty list initially", async () => {
    const res = await request(makeApp()).get("/api/conversations");

    expect(res.status).toBe(200);
    expect(res.body.data.conversations).toEqual([]);
  });
});

describe("POST /api/conversations", () => {
  it("creates a direct conversation", async () => {
    const res = await request(makeApp())
      .post("/api/conversations")
      .send({ type: "direct", participantIds: [PEER_ID] });

    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("direct");
    const userIds = res.body.data.participants.map(
      (p: { userId: string }) => p.userId
    );
    expect(userIds.sort()).toEqual([USER_ID, PEER_ID].sort());
  });

  it("reuses an existing direct conversation instead of creating a duplicate", async () => {
    const first = await request(makeApp())
      .post("/api/conversations")
      .send({ type: "direct", participantIds: [PEER_ID] });
    expect(first.status).toBe(201);

    const second = await request(makeApp())
      .post("/api/conversations")
      .send({ type: "direct", participantIds: [PEER_ID] });

    expect(second.status).toBe(200);
    expect(String(second.body.data._id)).toBe(String(first.body.data._id));
    expect(await Conversation.countDocuments({})).toBe(1);
  });

  it("rejects a direct conversation with more than 2 participants", async () => {
    const res = await request(makeApp())
      .post("/api/conversations")
      .send({ type: "direct", participantIds: [PEER_ID, "u3"] });

    expect(res.status).toBe(400);
  });

  it("requires at least one participant", async () => {
    const res = await request(makeApp())
      .post("/api/conversations")
      .send({ type: "direct", participantIds: [] });

    expect(res.status).toBe(400);
  });
});
