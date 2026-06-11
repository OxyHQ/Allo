import MessageEnvelope from "../models/MessageEnvelope";
import Message from "../models/Message";
import { daysFromNow } from "../config/multiDevice";

describe("MessageEnvelope model", () => {
  it("creates a per-device envelope", async () => {
    const envelope = await MessageEnvelope.create({
      messageId: "m1",
      conversationId: "c1",
      senderId: "a",
      senderDeviceId: 1,
      recipientUserId: "b",
      recipientDeviceId: 2,
      ciphertext: "AAAA",
      expiresAt: daysFromNow(90),
    });

    expect(envelope.recipientUserId).toBe("b");
    expect(envelope.recipientDeviceId).toBe(2);
    expect(envelope.ciphertext).toBe("AAAA");
    expect(envelope.deliveredAt).toBeUndefined();
  });

  it("enforces uniqueness per (messageId, recipientUserId, recipientDeviceId)", async () => {
    const base = {
      messageId: "m1",
      conversationId: "c1",
      senderId: "a",
      senderDeviceId: 1,
      recipientUserId: "b",
      recipientDeviceId: 2,
      ciphertext: "AAAA",
      expiresAt: daysFromNow(90),
    };
    await MessageEnvelope.create(base);
    await expect(MessageEnvelope.create({ ...base, ciphertext: "BBBB" })).rejects.toThrow();
  });

  it("allows distinct devices of the same recipient for one message", async () => {
    const base = {
      messageId: "m1",
      conversationId: "c1",
      senderId: "a",
      senderDeviceId: 1,
      recipientUserId: "b",
      ciphertext: "AAAA",
      expiresAt: daysFromNow(90),
    };
    await MessageEnvelope.create({ ...base, recipientDeviceId: 2 });
    const second = await MessageEnvelope.create({ ...base, recipientDeviceId: 3 });
    expect(second.recipientDeviceId).toBe(3);
  });

  it("declares a TTL index on expiresAt", () => {
    const indexes = MessageEnvelope.schema.indexes();
    const ttl = indexes.find(
      ([fields]) => (fields as Record<string, unknown>).expiresAt === 1
    );
    expect(ttl).toBeDefined();
    expect(ttl?.[1]).toMatchObject({ expireAfterSeconds: 0 });
  });

  it("declares the unique per-device index and the inbox index", () => {
    const indexes = MessageEnvelope.schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({
            messageId: 1,
            recipientUserId: 1,
            recipientDeviceId: 1,
          }),
          expect.objectContaining({ unique: true }),
        ]),
        expect.arrayContaining([
          expect.objectContaining({
            recipientUserId: 1,
            recipientDeviceId: 1,
            createdAt: -1,
          }),
        ]),
      ])
    );
  });
});

describe("Message model v3 (envelopes)", () => {
  it("accepts a v3 message with envelopeCount and no top-level ciphertext", async () => {
    const message = await Message.create({
      conversationId: "c1",
      senderId: "a",
      senderDeviceId: 1,
      encryptionVersion: 3,
      envelopeCount: 2,
      deliveredTo: ["a"],
    });

    expect(message.encryptionVersion).toBe(3);
    expect(message.envelopeCount).toBe(2);
    expect(message.ciphertext).toBeUndefined();
  });

  it("rejects a v3 message with no envelopes and no other content", async () => {
    await expect(
      Message.create({
        conversationId: "c1",
        senderId: "a",
        senderDeviceId: 1,
        encryptionVersion: 3,
        envelopeCount: 0,
        deliveredTo: ["a"],
      })
    ).rejects.toThrow(
      "Message must have either encrypted content, legacy plaintext, or a structured attachment"
    );
  });
});
