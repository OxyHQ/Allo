import Conversation from "../models/Conversation";
import Message from "../models/Message";
import LinkedAccount from "../models/LinkedAccount";
import ExternalContact from "../models/ExternalContact";
import BridgeOutbox from "../models/BridgeOutbox";

const OWNER = "owner-1";

describe("Bridge model changes (F3.0)", () => {
  describe("Conversation", () => {
    it("saves a bridged direct conversation with 1 participant + 1 externalParticipant", async () => {
      const conv = await Conversation.create({
        type: "direct",
        participants: [{ userId: OWNER, role: "admin", joinedAt: new Date() }],
        externalParticipants: [
          { network: "telegram", externalId: "tg-123", displayName: "Alice" },
        ],
        bridge: { network: "telegram", ownerUserId: OWNER, externalChatId: "tg-123" },
        createdBy: OWNER,
        unreadCounts: {},
      });

      expect(conv.bridge?.network).toBe("telegram");
      expect(conv.participants).toHaveLength(1);
      expect(conv.externalParticipants).toHaveLength(1);
      expect(conv.type).toBe("direct");
    });

    it("rejects a bridged conversation with no externalParticipant", async () => {
      await expect(
        Conversation.create({
          type: "direct",
          participants: [{ userId: OWNER, role: "admin", joinedAt: new Date() }],
          externalParticipants: [],
          bridge: { network: "telegram", ownerUserId: OWNER, externalChatId: "tg-1" },
          createdBy: OWNER,
          unreadCounts: {},
        })
      ).rejects.toThrow(
        "Bridged conversations require at least 1 participant and 1 externalParticipant"
      );
    });

    it("still requires a NON-bridged direct conversation to have exactly 2 participants", async () => {
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

    it("still rejects a NON-bridged group with fewer than 2 participants", async () => {
      await expect(
        Conversation.create({
          type: "group",
          participants: [{ userId: "a", joinedAt: new Date() }],
          createdBy: "a",
          unreadCounts: {},
        })
      ).rejects.toThrow();
    });

    it("declares the sparse-unique bridge index", () => {
      const indexes = Conversation.schema.indexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              "bridge.network": 1,
              "bridge.ownerUserId": 1,
              "bridge.externalChatId": 1,
            }),
            expect.objectContaining({ unique: true, sparse: true }),
          ]),
        ])
      );
    });
  });

  describe("Message", () => {
    it("saves a bridged inbound message with senderDeviceId 0 + external metadata", async () => {
      const message = await Message.create({
        conversationId: "c-bridge",
        senderId: "ext:telegram:tg-123",
        senderDeviceId: 0,
        text: "hi from telegram",
        external: {
          network: "telegram",
          externalSenderId: "tg-123",
          externalMessageId: "tg-msg-1",
          externalTimestamp: new Date(),
        },
        deliveredTo: [OWNER],
        encryptionVersion: 1,
      });

      expect(message.senderDeviceId).toBe(0);
      expect(message.external?.network).toBe("telegram");
      expect(message.external?.externalMessageId).toBe("tg-msg-1");
      expect(message.text).toBe("hi from telegram");
    });

    it("declares the sparse-unique (conversationId, external.externalMessageId) index", () => {
      const indexes = Message.schema.indexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({
              conversationId: 1,
              "external.externalMessageId": 1,
            }),
            expect.objectContaining({ unique: true, sparse: true }),
          ]),
        ])
      );
    });

    it("enforces dedup: a second message with the same (conversationId, externalMessageId) throws E11000", async () => {
      await Message.init();
      const base = {
        conversationId: "c-dedup",
        senderId: "ext:telegram:tg-9",
        senderDeviceId: 0,
        text: "dup",
        external: { network: "telegram" as const, externalMessageId: "tg-dup-1" },
        deliveredTo: [OWNER],
        encryptionVersion: 1,
      };
      await Message.create(base);
      await expect(Message.create({ ...base, text: "dup2" })).rejects.toMatchObject({
        code: 11000,
      });
    });
  });

  describe("LinkedAccount / ExternalContact / BridgeOutbox", () => {
    it("creates a LinkedAccount and declares its unique (userId, network) index", async () => {
      const account = await LinkedAccount.create({
        userId: OWNER,
        network: "telegram",
        status: "pending_login",
      });
      expect(account.status).toBe("pending_login");

      const indexes = LinkedAccount.schema.indexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ userId: 1, network: 1 }),
            expect.objectContaining({ unique: true }),
          ]),
        ])
      );
    });

    it("creates an ExternalContact and declares its unique compound index", async () => {
      const contact = await ExternalContact.create({
        ownerUserId: OWNER,
        network: "telegram",
        externalId: "tg-123",
        displayName: "Alice",
      });
      expect(contact.displayName).toBe("Alice");

      const indexes = ExternalContact.schema.indexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ ownerUserId: 1, network: 1, externalId: 1 }),
            expect.objectContaining({ unique: true }),
          ]),
        ])
      );
    });

    it("creates a BridgeOutbox with defaults and declares the sweeper index", async () => {
      const outbox = await BridgeOutbox.create({
        messageId: "m-1",
        command: {
          v: 1,
          type: "send",
          network: "telegram",
          ownerUserId: OWNER,
          externalChatId: "tg-123",
          messageId: "m-1",
          text: "hello",
        },
      });
      expect(outbox.status).toBe("pending");
      expect(outbox.attempts).toBe(0);

      const indexes = BridgeOutbox.schema.indexes();
      expect(indexes).toEqual(
        expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ status: 1, nextAttemptAt: 1 }),
          ]),
        ])
      );
    });
  });
});
