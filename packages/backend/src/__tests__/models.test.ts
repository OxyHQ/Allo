import Conversation from "../models/Conversation";
import Message from "../models/Message";
import Status from "../models/Status";
import Call from "../models/Call";
import { logger } from "../utils/logger";

describe("Conversation model", () => {
  it("creates a direct conversation with two participants", async () => {
    const conversation = await Conversation.create({
      type: "direct",
      participants: [
        { userId: "a", joinedAt: new Date() },
        { userId: "b", joinedAt: new Date() },
      ],
      createdBy: "a",
      unreadCounts: {},
    });

    expect(conversation.type).toBe("direct");
    expect(conversation.participants).toHaveLength(2);
    expect(conversation.createdAt).toBeInstanceOf(Date);
  });

  it("rejects a direct conversation that doesn't have exactly 2 participants", async () => {
    await expect(
      Conversation.create({
        type: "direct",
        participants: [
          { userId: "a", joinedAt: new Date() },
          { userId: "b", joinedAt: new Date() },
          { userId: "c", joinedAt: new Date() },
        ],
        createdBy: "a",
        unreadCounts: {},
      })
    ).rejects.toThrow("Direct conversations must have exactly 2 participants");
  });

  it("rejects conversations with fewer than 2 participants", async () => {
    await expect(
      Conversation.create({
        type: "group",
        participants: [{ userId: "a", joinedAt: new Date() }],
        createdBy: "a",
        unreadCounts: {},
      })
    ).rejects.toThrow();
  });

  it("declares the participant/lastMessageAt compound index", () => {
    const indexes = Conversation.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ "participants.userId": 1, lastMessageAt: -1 }),
        ]),
      ])
    );
  });
});

describe("Message model", () => {
  it("creates an encrypted message", async () => {
    const message = await Message.create({
      conversationId: "c1",
      senderId: "a",
      senderDeviceId: 1,
      ciphertext: "AAAA",
      encryptionVersion: 2,
      deliveredTo: ["a"],
    });

    expect(message.ciphertext).toBe("AAAA");
    expect(message.encryptionVersion).toBe(2);
    expect(message.messageType).toBe("text");
  });

  it("rejects an empty message (no content, no attachment)", async () => {
    await expect(
      Message.create({
        conversationId: "c1",
        senderId: "a",
        senderDeviceId: 1,
        deliveredTo: [],
      })
    ).rejects.toThrow(
      "Message must have either encrypted content, legacy plaintext, or a structured attachment"
    );
  });

  it("declares the conversation/createdAt compound index", () => {
    const indexes = Message.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ conversationId: 1, createdAt: -1 }),
        ]),
      ])
    );
  });

  it("Finding 8: a message with BOTH ciphertext and text still saves and warns via logger", async () => {
    // The pre-save hook now routes the both-content warning through `logger.warn`
    // (not console.warn). The warning is non-fatal — the message must still save.
    const warnSpy = jest.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const message = await Message.create({
        conversationId: "c1",
        senderId: "a",
        senderDeviceId: 1,
        ciphertext: "AAAA",
        text: "plaintext too",
        encryptionVersion: 2,
        deliveredTo: ["a"],
      });

      expect(message._id).toBeDefined();
      expect(message.ciphertext).toBe("AAAA");
      expect(message.text).toBe("plaintext too");
      expect(warnSpy).toHaveBeenCalledWith(
        "Message has both encrypted and plaintext content"
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("Status model", () => {
  it("creates a text status with a 24h expiry", async () => {
    const before = Date.now();
    const status = await Status.create({
      userId: "a",
      type: "text",
      text: "hello stories",
    });

    expect(status.expiresAt.getTime()).toBeGreaterThan(before);
    expect(status.expiresAt.getTime()).toBeLessThanOrEqual(
      before + 24 * 60 * 60 * 1000 + 5000
    );
    expect(status.audience.type).toBe("all-contacts");
  });

  it("rejects a text status without text", async () => {
    await expect(
      Status.create({ userId: "a", type: "text" })
    ).rejects.toThrow("Text statuses require non-empty `text`");
  });

  it("rejects a media status without mediaUrl", async () => {
    await expect(
      Status.create({ userId: "a", type: "image" })
    ).rejects.toThrow("image statuses require `mediaUrl`");
  });

  it("declares the TTL index on expiresAt", () => {
    const indexes = Status.schema.indexes();
    const ttl = indexes.find(
      ([fields]) => (fields as Record<string, unknown>).expiresAt === 1
    );
    expect(ttl).toBeDefined();
    expect(ttl?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });
});

describe("Call model", () => {
  it("creates a call with sensible defaults", async () => {
    const call = await Call.create({
      callerId: "a",
      calleeId: "b",
      type: "audio",
    });

    expect(call.status).toBe("initiated");
    expect(call.startedAt).toBeInstanceOf(Date);
  });

  it("rejects invalid call types and statuses", async () => {
    await expect(
      Call.create({ callerId: "a", calleeId: "b", type: "hologram" })
    ).rejects.toThrow();

    await expect(
      Call.create({ callerId: "a", calleeId: "b", type: "audio", status: "vanished" })
    ).rejects.toThrow();
  });

  it("declares history indexes for caller and callee", () => {
    const indexes = Call.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ callerId: 1, startedAt: -1 }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({ calleeId: 1, startedAt: -1 }),
        ]),
      ])
    );
  });
});
