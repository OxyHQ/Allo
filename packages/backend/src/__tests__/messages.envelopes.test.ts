import request from "supertest";
import { buildApp } from "./testApp";
import { installMockMessaging, type MockMessaging } from "./helpers/mockSocket";
import messagesRoutes from "../routes/messages";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import MessageEnvelope from "../models/MessageEnvelope";
import Device from "../models/Device";
import { ENVELOPE_DELIVERED_RETENTION_DAYS } from "../config/multiDevice";

const USER_ID = "u1";
const PEER_ID = "u2";

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

function makeApp(userId: string = USER_ID) {
  return buildApp({
    injectUserId: userId,
    mount: [{ path: "/api/messages", router: messagesRoutes }],
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

describe("POST /api/messages (v3 envelopes)", () => {
  let mock: MockMessaging;

  beforeEach(() => {
    mock = installMockMessaging();
  });

  afterEach(() => {
    mock.restore();
  });

  it("persists envelopes, sets envelopeCount, and fans out per-device emits", async () => {
    const conversation = await createDirectConversation();
    // Sender device 1 (current), sender's second device 2, peer device 1.
    await registerDevice(USER_ID, 1);
    await registerDevice(USER_ID, 2);
    await registerDevice(PEER_ID, 1);

    const envelopes = [
      { recipientUserId: USER_ID, recipientDeviceId: 2, ciphertext: wireCiphertext(1) },
      { recipientUserId: PEER_ID, recipientDeviceId: 1, ciphertext: wireCiphertext(2) },
    ];

    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        messageType: "text",
        envelopes,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.encryptionVersion).toBe(3);
    expect(res.body.data.envelopeCount).toBe(2);
    expect(res.body.data.ciphertext).toBeUndefined();

    const messageId = String(res.body.data._id);
    const stored = await MessageEnvelope.find({ messageId }).lean();
    expect(stored).toHaveLength(2);

    const peerEnvelope = stored.find((e) => e.recipientUserId === PEER_ID);
    expect(peerEnvelope?.recipientDeviceId).toBe(1);
    expect(peerEnvelope?.ciphertext).toBe(wireCiphertext(2));
    expect(peerEnvelope?.expiresAt).toBeInstanceOf(Date);

    // Per-device newMessage with that device's ciphertext.
    const peerDeviceEmits = mock.emitsTo(`device:${PEER_ID}:1`).filter((e) => e.event === "newMessage");
    expect(peerDeviceEmits).toHaveLength(1);
    expect((peerDeviceEmits[0].payload as { ciphertext: string }).ciphertext).toBe(wireCiphertext(2));

    const ownDeviceEmits = mock.emitsTo(`device:${USER_ID}:2`).filter((e) => e.event === "newMessage");
    expect(ownDeviceEmits).toHaveLength(1);
    expect((ownDeviceEmits[0].payload as { ciphertext: string }).ciphertext).toBe(wireCiphertext(1));

    // No ciphertext-bearing newMessage to conversation/user rooms for v3.
    expect(mock.emitsTo(`conversation:${String(conversation._id)}`).filter((e) => e.event === "newMessage")).toHaveLength(0);
    expect(mock.emitsOf("newMessage").filter((e) => e.room.startsWith("user:"))).toHaveLength(0);

    // conversationActivity to each participant's user room.
    expect(mock.emitsTo(`user:${USER_ID}`).filter((e) => e.event === "conversationActivity")).toHaveLength(1);
    expect(mock.emitsTo(`user:${PEER_ID}`).filter((e) => e.event === "conversationActivity")).toHaveLength(1);

    // Conversation preview is the encrypted placeholder; peer unread incremented.
    const updated = await Conversation.findById(conversation._id);
    expect(updated?.lastMessage?.text).toBe("[Encrypted]");
    expect(updated?.unreadCounts.get(PEER_ID)).toBe(1);
  });

  it("returns 409 stale_device_list when an active device has no envelope", async () => {
    const conversation = await createDirectConversation();
    await registerDevice(USER_ID, 1);
    await registerDevice(PEER_ID, 1);
    await registerDevice(PEER_ID, 2); // active, but no envelope provided

    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        envelopes: [
          { recipientUserId: PEER_ID, recipientDeviceId: 1, ciphertext: wireCiphertext(1) },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("stale_device_list");
    expect(res.body.missingDevices).toEqual(
      expect.arrayContaining([{ userId: PEER_ID, deviceId: 2 }])
    );
    expect(res.body.unknownDevices).toEqual([]);

    // Nothing persisted on a 409.
    expect(await Message.countDocuments({})).toBe(0);
    expect(await MessageEnvelope.countDocuments({})).toBe(0);
  });

  it("returns 409 with unknownDevices when an envelope targets an unregistered device", async () => {
    const conversation = await createDirectConversation();
    await registerDevice(USER_ID, 1);
    await registerDevice(PEER_ID, 1);

    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        envelopes: [
          { recipientUserId: PEER_ID, recipientDeviceId: 1, ciphertext: wireCiphertext(1) },
          { recipientUserId: PEER_ID, recipientDeviceId: 9, ciphertext: wireCiphertext(2) },
        ],
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("stale_device_list");
    expect(res.body.unknownDevices).toEqual(
      expect.arrayContaining([{ userId: PEER_ID, deviceId: 9 }])
    );
  });

  it("rejects an envelope recipient that is not a participant", async () => {
    const conversation = await createDirectConversation();
    await registerDevice(USER_ID, 1);
    await registerDevice(PEER_ID, 1);

    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        envelopes: [
          { recipientUserId: "stranger", recipientDeviceId: 1, ciphertext: wireCiphertext(1) },
          { recipientUserId: PEER_ID, recipientDeviceId: 1, ciphertext: wireCiphertext(2) },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("participant");
  });

  it("rejects a malformed v3 envelope payload", async () => {
    const conversation = await createDirectConversation();
    await registerDevice(USER_ID, 1);

    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        envelopes: [
          { recipientUserId: PEER_ID, recipientDeviceId: 1, ciphertext: "not-valid!!!" },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Malformed");
  });

  it("rejects a v3 message that also carries top-level ciphertext", async () => {
    const conversation = await createDirectConversation();
    await registerDevice(USER_ID, 1);
    await registerDevice(PEER_ID, 1);

    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        ciphertext: wireCiphertext(99), // not allowed for v3
        envelopes: [
          { recipientUserId: PEER_ID, recipientDeviceId: 1, ciphertext: wireCiphertext(1) },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_v3_payload");
    expect(await Message.countDocuments({})).toBe(0);
    expect(await MessageEnvelope.countDocuments({})).toBe(0);
  });

  it("rejects a v3 message that also carries top-level plaintext text", async () => {
    const conversation = await createDirectConversation();
    await registerDevice(USER_ID, 1);
    await registerDevice(PEER_ID, 1);

    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        text: "leak me", // not allowed for v3
        envelopes: [
          { recipientUserId: PEER_ID, recipientDeviceId: 1, ciphertext: wireCiphertext(1) },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_v3_payload");
    expect(await Message.countDocuments({})).toBe(0);
  });

  it("rejects an envelope addressed to the sender's own current device", async () => {
    const conversation = await createDirectConversation();
    await registerDevice(USER_ID, 1);
    await registerDevice(PEER_ID, 1);

    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        envelopes: [
          // Targets the sender's CURRENT device — invalid.
          { recipientUserId: USER_ID, recipientDeviceId: 1, ciphertext: wireCiphertext(1) },
          { recipientUserId: PEER_ID, recipientDeviceId: 1, ciphertext: wireCiphertext(2) },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_v3_payload");
    expect(res.body.message).toContain("own current device");
    expect(await Message.countDocuments({})).toBe(0);
    expect(await MessageEnvelope.countDocuments({})).toBe(0);
  });

  it("succeeds when insertMany hits a benign duplicate (bulk-write wrapper)", async () => {
    // Two envelopes for the SAME (recipientUserId, recipientDeviceId) map to two
    // envelope docs with the same unique key, so insertMany(ordered:false) throws
    // a MongoBulkWriteError with an E11000 in writeErrors. The request must still
    // succeed and persist the one surviving envelope (no zombie Message).
    // The unique index must exist for the duplicate to be rejected by the DB.
    await MessageEnvelope.init();
    const conversation = await createDirectConversation();
    await registerDevice(USER_ID, 1);
    await registerDevice(PEER_ID, 1);

    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        encryptionVersion: 3,
        envelopes: [
          { recipientUserId: PEER_ID, recipientDeviceId: 1, ciphertext: wireCiphertext(1) },
          { recipientUserId: PEER_ID, recipientDeviceId: 1, ciphertext: wireCiphertext(1) },
        ],
      });

    expect(res.status).toBe(201);
    const messageId = String(res.body.data._id);

    // The Message survives (not deleted as a zombie).
    expect(await Message.countDocuments({ _id: messageId })).toBe(1);
    // Exactly one envelope persisted for the duplicated target.
    expect(await MessageEnvelope.countDocuments({ messageId })).toBe(1);
  });
});

describe("GET /api/messages (v3 hydration)", () => {
  async function seedV3Message() {
    const conversation = await createDirectConversation();
    const message = await Message.create({
      conversationId: String(conversation._id),
      senderId: PEER_ID,
      senderDeviceId: 1,
      encryptionVersion: 3,
      envelopeCount: 1,
      deliveredTo: [PEER_ID],
    });
    await MessageEnvelope.create({
      messageId: String(message._id),
      conversationId: String(conversation._id),
      senderId: PEER_ID,
      senderDeviceId: 1,
      recipientUserId: USER_ID,
      recipientDeviceId: 5,
      ciphertext: wireCiphertext(42),
      expiresAt: new Date(Date.now() + 1000000),
    });
    return conversation;
  }

  it("returns the device's ciphertext when X-Device-Id matches", async () => {
    const conversation = await seedV3Message();
    const res = await request(makeApp())
      .get("/api/messages")
      .set("X-Device-Id", "5")
      .query({ conversationId: String(conversation._id) });

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(1);
    expect(res.body.data.messages[0].ciphertext).toBe(wireCiphertext(42));
    expect(res.body.data.messages[0].envelopeMissing).toBe(false);
  });

  it("masks ciphertext and flags envelopeMissing for a wrong device", async () => {
    const conversation = await seedV3Message();
    const res = await request(makeApp())
      .get("/api/messages")
      .set("X-Device-Id", "6")
      .query({ conversationId: String(conversation._id) });

    expect(res.status).toBe(200);
    expect(res.body.data.messages[0].ciphertext).toBeNull();
    expect(res.body.data.messages[0].envelopeMissing).toBe(true);
  });

  it("masks ciphertext when no X-Device-Id header is present", async () => {
    const conversation = await seedV3Message();
    const res = await request(makeApp())
      .get("/api/messages")
      .query({ conversationId: String(conversation._id) });

    expect(res.status).toBe(200);
    expect(res.body.data.messages[0].ciphertext).toBeNull();
    expect(res.body.data.messages[0].envelopeMissing).toBe(true);
  });
});

describe("POST /api/messages/:id/delivered (v3)", () => {
  it("sets deliveredAt and shortens expiresAt for the device's envelope", async () => {
    const conversation = await createDirectConversation();
    const message = await Message.create({
      conversationId: String(conversation._id),
      senderId: PEER_ID,
      senderDeviceId: 1,
      encryptionVersion: 3,
      envelopeCount: 1,
      deliveredTo: [PEER_ID],
    });
    const farFuture = new Date(Date.now() + 80 * 24 * 60 * 60 * 1000);
    await MessageEnvelope.create({
      messageId: String(message._id),
      conversationId: String(conversation._id),
      senderId: PEER_ID,
      senderDeviceId: 1,
      recipientUserId: USER_ID,
      recipientDeviceId: 5,
      ciphertext: wireCiphertext(1),
      expiresAt: farFuture,
    });

    const res = await request(makeApp())
      .post(`/api/messages/${message._id}/delivered`)
      .set("X-Device-Id", "5")
      .send({});

    expect(res.status).toBe(200);

    const env = await MessageEnvelope.findOne({
      messageId: String(message._id),
      recipientDeviceId: 5,
    }).lean();
    expect(env?.deliveredAt).toBeInstanceOf(Date);
    // expiresAt shortened to ~ now + ENVELOPE_DELIVERED_RETENTION_DAYS (< far future).
    const upper = Date.now() + (ENVELOPE_DELIVERED_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    expect(env?.expiresAt.getTime()).toBeLessThan(upper);
    expect(env?.expiresAt.getTime()).toBeLessThan(farFuture.getTime());

    const updated = await Message.findById(message._id);
    expect(updated?.deliveredTo).toContain(USER_ID);
  });

  it("does NOT shorten the sender's own sync-envelope TTL", async () => {
    // The sender (USER_ID) authored the message; their own per-device sync
    // envelope must keep its full retention so other devices can still catch up.
    const conversation = await createDirectConversation();
    const message = await Message.create({
      conversationId: String(conversation._id),
      senderId: USER_ID,
      senderDeviceId: 1,
      encryptionVersion: 3,
      envelopeCount: 1,
      deliveredTo: [USER_ID],
    });
    const farFuture = new Date(Date.now() + 80 * 24 * 60 * 60 * 1000);
    await MessageEnvelope.create({
      messageId: String(message._id),
      conversationId: String(conversation._id),
      senderId: USER_ID,
      senderDeviceId: 1,
      recipientUserId: USER_ID, // sender's OTHER device sync envelope
      recipientDeviceId: 2,
      ciphertext: wireCiphertext(1),
      expiresAt: farFuture,
    });

    const res = await request(makeApp())
      .post(`/api/messages/${message._id}/delivered`)
      .set("X-Device-Id", "2")
      .send({});

    expect(res.status).toBe(200);

    const env = await MessageEnvelope.findOne({
      messageId: String(message._id),
      recipientDeviceId: 2,
    }).lean();
    // Untouched: no deliveredAt, full expiresAt preserved.
    expect(env?.deliveredAt).toBeUndefined();
    expect(env?.expiresAt.getTime()).toBe(farFuture.getTime());
  });
});

describe("POST /api/messages/:id/read emits messageRead", () => {
  let mock: MockMessaging;

  beforeEach(() => {
    mock = installMockMessaging();
  });

  afterEach(() => {
    mock.restore();
  });

  it("emits messageRead to the conversation and the reader's user room", async () => {
    const conversation = await createDirectConversation();
    const message = await Message.create({
      conversationId: String(conversation._id),
      senderId: PEER_ID,
      senderDeviceId: 1,
      text: "read me",
      deliveredTo: [PEER_ID],
    });

    const res = await request(makeApp()).post(`/api/messages/${message._id}/read`).send({});
    expect(res.status).toBe(200);

    const convoEmits = mock
      .emitsTo(`conversation:${String(conversation._id)}`)
      .filter((e) => e.event === "messageRead");
    expect(convoEmits).toHaveLength(1);
    expect((convoEmits[0].payload as { userId: string }).userId).toBe(USER_ID);

    const userEmits = mock.emitsTo(`user:${USER_ID}`).filter((e) => e.event === "messageRead");
    expect(userEmits).toHaveLength(1);
  });
});

describe("DELETE /api/messages/:id (everyone) removes envelopes", () => {
  it("deletes all envelopes for the message", async () => {
    const conversation = await createDirectConversation();
    const message = await Message.create({
      conversationId: String(conversation._id),
      senderId: USER_ID,
      senderDeviceId: 1,
      encryptionVersion: 3,
      envelopeCount: 2,
      deliveredTo: [USER_ID],
    });
    await MessageEnvelope.insertMany([
      {
        messageId: String(message._id),
        conversationId: String(conversation._id),
        senderId: USER_ID,
        senderDeviceId: 1,
        recipientUserId: PEER_ID,
        recipientDeviceId: 1,
        ciphertext: wireCiphertext(1),
        expiresAt: new Date(Date.now() + 1000000),
      },
      {
        messageId: String(message._id),
        conversationId: String(conversation._id),
        senderId: USER_ID,
        senderDeviceId: 1,
        recipientUserId: USER_ID,
        recipientDeviceId: 2,
        ciphertext: wireCiphertext(2),
        expiresAt: new Date(Date.now() + 1000000),
      },
    ]);

    const res = await request(makeApp())
      .delete(`/api/messages/${message._id}`)
      .query({ scope: "everyone" });

    expect(res.status).toBe(200);
    expect(await MessageEnvelope.countDocuments({ messageId: String(message._id) })).toBe(0);
  });
});

describe("v1/v2 paths remain unchanged with the envelope code present", () => {
  it("still creates a plaintext message", async () => {
    const conversation = await createDirectConversation();
    const res = await request(makeApp())
      .post("/api/messages")
      .send({ conversationId: String(conversation._id), senderDeviceId: 1, text: "hola" });

    expect(res.status).toBe(201);
    expect(res.body.data.text).toBe("hola");
  });

  it("still creates a v2 encrypted message and does not create envelopes", async () => {
    const conversation = await createDirectConversation();
    const res = await request(makeApp())
      .post("/api/messages")
      .send({
        conversationId: String(conversation._id),
        senderDeviceId: 1,
        encryptionVersion: 2,
        ciphertext: wireCiphertext(7),
      });

    expect(res.status).toBe(201);
    expect(res.body.data.ciphertext).toBe(wireCiphertext(7));
    expect(await MessageEnvelope.countDocuments({})).toBe(0);
  });
});
