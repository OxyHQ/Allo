/**
 * The messaging repositories, against a REAL Postgres server.
 *
 * A mocked `insert` accepts any statement, including one the server rejects
 * outright — and every property worth asserting about this domain is one only a
 * server has: a deferred constraint trigger judged at COMMIT, `ON CONFLICT`
 * against a unique index, `xmax`, `nulls last`, an increment evaluated in SQL,
 * and two levels of `ON DELETE CASCADE`. There is nothing here a mock could tell
 * the truth about.
 *
 * The cases are grouped by the CLAIM they pin rather than by function, because
 * several of the claims (the Mongo `Map` asymmetry, the lost-update fix) are
 * about how two functions differ from each other.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, constraintNameOf, isCheckViolation } from "@oxyhq/db";
import type postgres from "postgres";
import { and, eq } from "drizzle-orm";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import * as schema from "../../db/schema";
import {
  addParticipants,
  createConversation,
  findConversationForParticipant,
  findDirectConversationBetween,
  isConversationParticipant,
  listConversationsForUser,
  markConversationRead,
  removeParticipant,
  setConversationArchived,
  updateConversationDetails,
} from "../../db/messaging/conversationRepository";
import {
  createMessage,
  editMessageText,
  findMessageById,
  listConversationMessages,
  markMessageDelivered,
  markMessageRead,
  softDeleteMessage,
  toggleReaction,
} from "../../db/messaging/messageRepository";
import {
  deleteDevice,
  findDevice,
  findDevicePreKeys,
  listDeviceBundlesForUser,
  listDevicesForUser,
  registerDevice,
  updateDeviceKeys,
} from "../../db/messaging/deviceRepository";
import { toConversationDto, toConversationParticipant } from "../../utils/conversationDto";
import { toMessageDto } from "../../utils/messageDto";

let handle: TestDatabaseHandle;
let db: ReturnType<typeof createDatabase<typeof schema>>["db"];
let client: postgres.Sql;

/** Unique per call, so cases cannot collide inside the one shared database. */
let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

/**
 * Block until at least `expected` backends are waiting on a row lock in this
 * database, or fail loudly.
 *
 * This is the anti-vacuity guard for the interleaving test below: if the send
 * never actually blocks, the race it claims to exercise did not happen and a
 * green result would be meaningless. Throwing names that outright rather than
 * letting the assertion pass for the wrong reason.
 */
async function waitForBlockedBackend(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await client<{ count: string }[]>`
      select count(*)::text as count from pg_stat_activity
      where wait_event_type = 'Lock' and datname = current_database()
    `;
    if (Number(rows[0].count) >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `no backend ever blocked on a row lock; the interleaving under test never occurred`,
  );
}

/** A two-person `direct` conversation and the two user ids in it. */
async function directConversation(): Promise<{
  conversationId: string;
  alice: string;
  bob: string;
}> {
  const alice = uid("alice");
  const bob = uid("bob");
  const conversation = await createConversation(db, {
    type: "direct",
    createdBy: alice,
    participants: [
      { userId: alice, role: "admin" },
      { userId: bob, role: "member" },
    ],
  });
  return { conversationId: conversation.id, alice, bob };
}

beforeAll(async () => {
  handle = await setUpTestDatabase();
  const created = createDatabase({ databaseUrl: handle.databaseUrl, schema });
  db = created.db;
  client = created.client;
}, 180_000);

afterAll(async () => {
  await client?.end();
  await handle?.drop();
});

describe("creating a conversation, which the deferred trigger makes indivisible", () => {
  it("writes the conversation and its participants in one transaction", async () => {
    const { conversationId, alice, bob } = await directConversation();
    const found = await findConversationForParticipant(db, conversationId, alice);

    expect(found).not.toBeNull();
    expect(found?.participants.map((p) => p.userId).sort()).toEqual([alice, bob].sort());
    // The role the caller asked for, not a default applied by the table.
    expect(found?.participants.find((p) => p.userId === alice)?.role).toBe("admin");
    expect(found?.participants.find((p) => p.userId === bob)?.role).toBe("member");
  });

  it("is refused at COMMIT when a direct conversation would not have exactly 2", async () => {
    const solo = uid("solo");
    const error = await createConversation(db, {
      type: "direct",
      createdBy: solo,
      participants: [{ userId: solo, role: "admin" }],
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).not.toBeNull();
    // By NAME, off `cause`. A regex over the driver's message text would pass
    // for a different constraint raised by the same statement.
    expect(constraintNameOf(error)).toBe("conversations_participant_count_check");
  });

  it("leaves nothing behind when the trigger refuses", async () => {
    const before = await client<{ count: string }[]>`select count(*) from conversations`;
    const solo = uid("solo");
    await createConversation(db, {
      type: "direct",
      createdBy: solo,
      participants: [{ userId: solo, role: "admin" }],
    }).catch(() => undefined);
    const after = await client<{ count: string }[]>`select count(*) from conversations`;

    // The conversation row is written before its participants; if the rollback
    // were not whole, this is where the orphan would show up.
    expect(after[0].count).toBe(before[0].count);
  });
});

describe("the conversation list", () => {
  it("puts conversations that never received a message LAST, as Mongo did", async () => {
    // The porting trap this whole test exists for. Mongo sorts a missing value
    // lowest, so `{lastMessageAt: -1}` sent never-used conversations to the end;
    // Postgres defaults `desc` to NULLS FIRST, which would open every user's
    // list on the empty conversations they once created.
    const owner = uid("owner");
    const other = uid("other");

    const quiet = await createConversation(db, {
      type: "direct",
      createdBy: owner,
      participants: [
        { userId: owner, role: "admin" },
        { userId: other, role: "member" },
      ],
    });
    const active = await createConversation(db, {
      type: "direct",
      createdBy: owner,
      participants: [
        { userId: owner, role: "admin" },
        { userId: uid("third"), role: "member" },
      ],
    });
    await createMessage(db, {
      conversationId: active.id,
      senderId: owner,
      senderDeviceId: 1,
      ciphertext: "hello",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    const listed = await listConversationsForUser(db, { userId: owner, limit: 50, offset: 0 });
    const ids = listed.map((conversation) => conversation.id);

    expect(ids.indexOf(active.id)).toBeLessThan(ids.indexOf(quiet.id));
    expect(ids).toContain(quiet.id);
  });

  it("hides a conversation the caller archived, and only for them", async () => {
    const { conversationId, alice, bob } = await directConversation();

    expect(await setConversationArchived(db, conversationId, alice, true)).toBe(true);

    const forAlice = await listConversationsForUser(db, { userId: alice, limit: 50, offset: 0 });
    const forBob = await listConversationsForUser(db, { userId: bob, limit: 50, offset: 0 });

    expect(forAlice.map((c) => c.id)).not.toContain(conversationId);
    // `archivedBy` was a list on the conversation in Mongo; as a column on the
    // membership row, one person's archive cannot reach the other's list.
    expect(forBob.map((c) => c.id)).toContain(conversationId);

    await setConversationArchived(db, conversationId, alice, false);
    const restored = await listConversationsForUser(db, { userId: alice, limit: 50, offset: 0 });
    expect(restored.map((c) => c.id)).toContain(conversationId);
  });

  it("carries each participant's own unread count and last-read time", async () => {
    const { conversationId, alice, bob } = await directConversation();
    await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "hi",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    const forBob = await listConversationsForUser(db, { userId: bob, limit: 50, offset: 0 });
    const conversation = forBob.find((c) => c.id === conversationId);
    expect(conversation?.participants.find((p) => p.userId === bob)?.unreadCount).toBe(1);
    expect(conversation?.participants.find((p) => p.userId === alice)?.unreadCount).toBe(0);

    expect(await markConversationRead(db, conversationId, bob)).toBe(true);
    const afterRead = await findConversationForParticipant(db, conversationId, bob);
    const bobRow = afterRead?.participants.find((p) => p.userId === bob);
    expect(bobRow?.unreadCount).toBe(0);
    expect(bobRow?.lastReadAt).toBeInstanceOf(Date);
  });
});

describe("membership is the authorization primitive", () => {
  it("answers the same way for a stranger as for a conversation that does not exist", async () => {
    const { conversationId } = await directConversation();
    const stranger = uid("stranger");

    expect(await findConversationForParticipant(db, conversationId, stranger)).toBeNull();
    expect(await findConversationForParticipant(db, uid("nope"), stranger)).toBeNull();
    expect(await isConversationParticipant(db, conversationId, stranger)).toBe(false);
  });

  it("agrees with the full lookup for a real participant", async () => {
    const { conversationId, bob } = await directConversation();
    expect(await isConversationParticipant(db, conversationId, bob)).toBe(true);
    expect(await findConversationForParticipant(db, conversationId, bob)).not.toBeNull();
  });
});

describe("finding the existing direct conversation between two people", () => {
  it("matches the pair, and does not match a group that merely contains them", async () => {
    const alice = uid("alice");
    const bob = uid("bob");
    const carol = uid("carol");

    const group = await createConversation(db, {
      type: "group",
      createdBy: alice,
      participants: [
        { userId: alice, role: "admin" },
        { userId: bob, role: "member" },
        { userId: carol, role: "member" },
      ],
    });
    const direct = await createConversation(db, {
      type: "direct",
      createdBy: alice,
      participants: [
        { userId: alice, role: "admin" },
        { userId: bob, role: "member" },
      ],
    });

    const found = await findDirectConversationBetween(db, [alice, bob]);
    expect(found?.id).toBe(direct.id);
    expect(found?.id).not.toBe(group.id);

    expect(await findDirectConversationBetween(db, [alice, uid("nobody")])).toBeNull();
  });
});

describe("changing a group's membership", () => {
  it("converges when the same person is added twice", async () => {
    const alice = uid("alice");
    const bob = uid("bob");
    const carol = uid("carol");
    const group = await createConversation(db, {
      type: "group",
      createdBy: alice,
      participants: [
        { userId: alice, role: "admin" },
        { userId: bob, role: "member" },
      ],
    });

    await addParticipants(db, group.id, [{ userId: carol, role: "member" }]);
    // Mongo filtered the request against an in-memory member list, so two
    // concurrent adds both saw an absence. The unique index answers it instead.
    const after = await addParticipants(db, group.id, [{ userId: carol, role: "member" }]);

    expect(after?.participants.filter((p) => p.userId === carol)).toHaveLength(1);
    expect(after?.participants).toHaveLength(3);
  });

  it("reports the count rule as an outcome rather than an exception", async () => {
    const { conversationId, bob } = await directConversation();

    const outcome = await removeParticipant(db, conversationId, bob);

    // The rule is the deferred trigger's, translated by CONSTRAINT NAME into
    // something the route can answer 400 with.
    expect(outcome).toEqual({ outcome: "would_leave_too_few" });
    const survivors = await client<{ count: string }[]>`
      select count(*) from conversation_participants where conversation_id = ${conversationId}
    `;
    expect(survivors[0].count).toBe("2");
  });

  it("removes a participant when enough remain", async () => {
    const alice = uid("alice");
    const bob = uid("bob");
    const carol = uid("carol");
    const group = await createConversation(db, {
      type: "group",
      createdBy: alice,
      participants: [
        { userId: alice, role: "admin" },
        { userId: bob, role: "member" },
        { userId: carol, role: "member" },
      ],
    });

    expect(await removeParticipant(db, group.id, carol)).toEqual({ outcome: "removed" });
    expect(await removeParticipant(db, group.id, carol)).toEqual({ outcome: "not_a_participant" });
  });
});

describe("updating a conversation's details", () => {
  it("applies only the fields named, and distinguishes clearing from leaving alone", async () => {
    const alice = uid("alice");
    const group = await createConversation(db, {
      type: "group",
      createdBy: alice,
      participants: [
        { userId: alice, role: "admin" },
        { userId: uid("bob"), role: "member" },
      ],
      name: "Original",
      description: "Described",
    });

    const renamed = await updateConversationDetails(db, group.id, { name: "Renamed" });
    expect(renamed?.name).toBe("Renamed");
    // Untouched because the patch did not name it — a spread of a request body
    // would have written `undefined` over it.
    expect(renamed?.description).toBe("Described");

    const cleared = await updateConversationDetails(db, group.id, { description: null });
    expect(cleared?.description).toBeNull();
    expect(cleared?.name).toBe("Renamed");
  });

  it("does not write at all when the patch is empty", async () => {
    const { conversationId } = await directConversation();
    const before = await client<{ xmin: string }[]>`
      select xmin::text from conversations where id = ${conversationId}
    `;

    const result = await updateConversationDetails(db, conversationId, {});

    const after = await client<{ xmin: string }[]>`
      select xmin::text from conversations where id = ${conversationId}
    `;
    expect(result).not.toBeNull();
    // `xmin` is the row's transaction id: an UPDATE writing identical values
    // still moves it, which is what comparing columns would miss.
    expect(after[0].xmin).toBe(before[0].xmin);
  });
});

describe("sending a message, which Mongo did as two independent saves", () => {
  it("writes the message, the sender's delivery and the conversation preview together", async () => {
    const { conversationId, alice, bob } = await directConversation();

    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 3,
      ciphertext: "base64",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    // A sender has by definition received their own message.
    expect(message.deliveredTo).toEqual([alice]);
    expect(message.senderDeviceId).toBe(3);

    const conversation = await findConversationForParticipant(db, conversationId, bob);
    expect(conversation?.lastMessage?.text).toBe("[Encrypted]");
    expect(conversation?.lastMessage?.senderId).toBe(alice);
    // The preview's timestamp IS the message's, not a second clock reading.
    expect(conversation?.lastMessage?.timestamp.getTime()).toBe(message.createdAt.getTime());
    expect(conversation?.lastMessageAt?.getTime()).toBe(message.createdAt.getTime());
  });

  it("increments everyone else's unread count and never the sender's", async () => {
    const alice = uid("alice");
    const bob = uid("bob");
    const carol = uid("carol");
    const group = await createConversation(db, {
      type: "group",
      createdBy: alice,
      participants: [
        { userId: alice, role: "admin" },
        { userId: bob, role: "member" },
        { userId: carol, role: "member" },
      ],
    });

    await createMessage(db, {
      conversationId: group.id,
      senderId: alice,
      senderDeviceId: 1,
      text: "legacy plaintext",
      messageType: "text",
      lastMessagePreview: "legacy plaintext",
    });

    const after = await findConversationForParticipant(db, group.id, alice);
    expect(after?.participants.find((p) => p.userId === alice)?.unreadCount).toBe(0);
    expect(after?.participants.find((p) => p.userId === bob)?.unreadCount).toBe(1);
    expect(after?.participants.find((p) => p.userId === carol)?.unreadCount).toBe(1);
  });

  it("counts both of two concurrent sends", async () => {
    // Note what this does and does NOT pin — it is kept as a total-correctness
    // check, not a race, and CONVENTIONS.md §"Concurrency tests here are prone
    // to passing vacuously" is why that distinction is written down instead of
    // left for someone to rediscover. Two reasons it cannot discriminate: both
    // sends update the conversation row before touching participants, so the
    // second blocks there and a read-modify-write reaches 2 as well (verified by
    // mutation — this case stays green against one); and postgres.js opens
    // connections on demand, so a burst like this can queue onto one connection
    // and simply run in order. The discriminating case is the next test, and it
    // fails loudly rather than silently if its interleaving never happens.
    const { conversationId, alice, bob } = await directConversation();

    await Promise.all([
      createMessage(db, {
        conversationId,
        senderId: alice,
        senderDeviceId: 1,
        ciphertext: "one",
        messageType: "text",
        lastMessagePreview: "[Encrypted]",
      }),
      createMessage(db, {
        conversationId,
        senderId: alice,
        senderDeviceId: 1,
        ciphertext: "two",
        messageType: "text",
        lastMessagePreview: "[Encrypted]",
      }),
    ]);

    const conversation = await findConversationForParticipant(db, conversationId, bob);
    expect(conversation?.participants.find((p) => p.userId === bob)?.unreadCount).toBe(2);
  });

  it("does not clobber a mark-read that commits while the send is in flight", async () => {
    // The case the SQL-side increment actually exists for. `markConversationRead`
    // touches the PARTICIPANT row and not the conversation row, so it does not
    // serialize behind the send the way another send does. A read-modify-write
    // reads the backlog, blocks on the row lock, and then writes `stale + 1`
    // over the zero the reader just committed — the badge comes back on a
    // conversation the user has just read.
    const { conversationId, alice, bob } = await directConversation();
    for (let index = 0; index < 5; index += 1) {
      await createMessage(db, {
        conversationId,
        senderId: alice,
        senderDeviceId: 1,
        ciphertext: `backlog-${String(index)}`,
        messageType: "text",
        lastMessagePreview: "[Encrypted]",
      });
    }

    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let lockTaken: (() => void) | undefined;
    const locked = new Promise<void>((resolve) => {
      lockTaken = resolve;
    });

    // Holds bob's participant row locked, so the send below blocks precisely
    // between reading his count and writing it.
    const reader = db.transaction(async (tx) => {
      await tx
        .update(schema.conversationParticipants)
        .set({ unreadCount: 0, lastReadAt: new Date() })
        .where(
          and(
            eq(schema.conversationParticipants.conversationId, conversationId),
            eq(schema.conversationParticipants.userId, bob),
          ),
        );
      lockTaken?.();
      await held;
    });

    await locked;
    const send = createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "arrives-during-read",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    // Anti-vacuity: if nothing ever blocks, the interleaving this test depends
    // on never happened and a pass would mean nothing.
    await waitForBlockedBackend(1);
    release?.();
    await reader;
    await send;

    const conversation = await findConversationForParticipant(db, conversationId, bob);
    expect(conversation?.participants.find((p) => p.userId === bob)?.unreadCount).toBe(1);
  });

  it("is refused by the content CHECK when it carries neither ciphertext nor plaintext", async () => {
    const { conversationId, alice } = await directConversation();

    const error = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      messageType: "text",
      lastMessagePreview: null,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).not.toBeNull();
    expect(isCheckViolation(error)).toBe(true);
    expect(constraintNameOf(error)).toBe("messages_content_present_check");
  });

  it("leaves the conversation preview untouched when the message is refused", async () => {
    const { conversationId, alice } = await directConversation();
    await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "first",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });
    const before = await findConversationForParticipant(db, conversationId, alice);

    await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      messageType: "text",
      lastMessagePreview: "SHOULD NOT APPEAR",
    }).catch(() => undefined);

    const after = await findConversationForParticipant(db, conversationId, alice);
    expect(after?.lastMessage?.text).toBe("[Encrypted]");
    expect(after?.lastMessageAt?.getTime()).toBe(before?.lastMessageAt?.getTime());
  });

  it("round-trips the two jsonb media arrays whole", async () => {
    const { conversationId, alice } = await directConversation();
    const encrypted = [
      { id: "m1", type: "image" as const, ciphertext: "cipher", fileSize: 42, mimeType: "image/png" },
    ];

    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      encryptedMedia: encrypted,
      messageType: "media",
      lastMessagePreview: "[Encrypted]",
    });

    const reloaded = await findMessageById(db, message.id);
    // Opaque envelopes the server cannot read: they must come back byte-identical,
    // which is the whole reason they stayed `jsonb` on the row.
    expect(reloaded?.encryptedMedia).toEqual(encrypted);
    expect(reloaded?.media).toEqual([]);
    expect(reloaded?.messageType).toBe("media");
  });
});

describe("reading a conversation's messages", () => {
  it("returns them oldest-first and excludes soft-deleted ones", async () => {
    const { conversationId, alice } = await directConversation();
    const first = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "one",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });
    const second = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "two",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });
    const third = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "three",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    const page = await listConversationMessages(db, { conversationId, limit: 50 });
    expect(page.map((m) => m.id)).toEqual([first.id, second.id, third.id]);

    await softDeleteMessage(db, second.id, alice);
    const afterDelete = await listConversationMessages(db, { conversationId, limit: 50 });
    expect(afterDelete.map((m) => m.id)).toEqual([first.id, third.id]);
  });

  it("takes the NEWEST page under a limit, then hands it back chronologically", async () => {
    const { conversationId, alice } = await directConversation();
    const sent: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const message = await createMessage(db, {
        conversationId,
        senderId: alice,
        senderDeviceId: 1,
        ciphertext: `m${String(index)}`,
        messageType: "text",
        lastMessagePreview: "[Encrypted]",
      });
      sent.push(message.id);
    }

    const page = await listConversationMessages(db, { conversationId, limit: 2 });
    // The last two sent, in the order they were sent — not the first two.
    expect(page.map((m) => m.id)).toEqual(sent.slice(-2));
  });

  it("pages backwards from a cursor", async () => {
    const { conversationId, alice } = await directConversation();
    const first = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "one",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });
    const second = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "two",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    const older = await listConversationMessages(db, {
      conversationId,
      limit: 50,
      before: second.createdAt,
    });
    expect(older.map((m) => m.id)).toEqual([first.id]);
  });
});

describe("the two Mongo Maps did not behave the same, and both behaviours survive", () => {
  it("a read receipt is one row per person and its timestamp MOVES on a repeat", async () => {
    const { conversationId, alice, bob } = await directConversation();
    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "hi",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    const firstRead = await markMessageRead(db, message.id, bob);
    const firstAt = firstRead?.readBy[bob];
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondRead = await markMessageRead(db, message.id, bob);
    const secondAt = secondRead?.readBy[bob];

    const rows = await client<{ count: string }[]>`
      select count(*) from message_reads where message_id = ${message.id}
    `;
    // Idempotent in the sense that matters: the unique index, not a read-then-write.
    expect(rows[0].count).toBe("1");
    expect(firstAt).toBeInstanceOf(Date);
    expect(secondAt).toBeInstanceOf(Date);
    // `readBy.set(userId, new Date())` overwrote. Preserved deliberately.
    expect(secondAt?.getTime()).toBeGreaterThan(firstAt?.getTime() ?? 0);
  });

  it("a delivery receipt is one row per person and KEEPS the first timestamp", async () => {
    const { conversationId, alice, bob } = await directConversation();
    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "hi",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    const first = await markMessageDelivered(db, message.id, bob);
    const firstRow = await client<{ delivered_at: string }[]>`
      select delivered_at::text from message_deliveries
      where message_id = ${message.id} and user_id = ${bob}
    `;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await markMessageDelivered(db, message.id, bob);
    const secondRow = await client<{ delivered_at: string }[]>`
      select delivered_at::text from message_deliveries
      where message_id = ${message.id} and user_id = ${bob}
    `;

    expect(first?.deliveredTo).toEqual([alice, bob]);
    // `deliveredTo` was pushed only `if (!includes(userId))` — first write wins,
    // which is the OPPOSITE of the read receipt above and is inherited, not chosen.
    expect(secondRow[0].delivered_at).toBe(firstRow[0].delivered_at);
  });
});

describe("reactions", () => {
  it("toggles the caller's own and leaves everyone else's alone", async () => {
    const { conversationId, alice, bob } = await directConversation();
    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "hi",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    const added = await toggleReaction(db, message.id, bob, "👍");
    expect(added.hasReacted).toBe(true);
    expect(added.reactions["👍"]).toEqual([bob]);

    const alsoAlice = await toggleReaction(db, message.id, alice, "👍");
    expect(alsoAlice.reactions["👍"]).toEqual([bob, alice]);

    const removed = await toggleReaction(db, message.id, bob, "👍");
    expect(removed.hasReacted).toBe(false);
    // Mongo rewrote the whole `Map<emoji, userId[]>`, so a concurrent reaction
    // was simply overwritten; one row per (message, user, emoji) cannot be.
    expect(removed.reactions["👍"]).toEqual([alice]);
  });

  it("drops an emoji's key once its last reactor leaves, which Mongo did not", async () => {
    // The one divergence in this domain that is forced by the schema rather
    // than chosen. Mongo removed a reaction with `set(emoji, filtered)`, never
    // `delete(emoji)`, so an emoji that had ever been used stayed in the
    // document as `[]` forever. The table's grain is (message, user, emoji), so
    // "zero reactors" has no row to be, and a client must read a missing key and
    // an empty array as the same thing.
    const { conversationId, alice, bob } = await directConversation();
    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "hi",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    await toggleReaction(db, message.id, bob, "👍");
    const afterRemoval = await toggleReaction(db, message.id, bob, "👍");

    expect(afterRemoval.hasReacted).toBe(false);
    expect(afterRemoval.reactions).toEqual({});
    expect("👍" in afterRemoval.reactions).toBe(false);

    const reloaded = await findMessageById(db, message.id);
    expect(reloaded?.reactions).toEqual({});
  });

  it("keeps different emoji apart and hydrates them onto the message", async () => {
    const { conversationId, alice, bob } = await directConversation();
    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "hi",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    await toggleReaction(db, message.id, bob, "👍");
    await toggleReaction(db, message.id, bob, "🎉");

    const reloaded = await findMessageById(db, message.id);
    expect(reloaded?.reactions).toEqual({ "👍": [bob], "🎉": [bob] });
  });
});

describe("editing and deleting, where ownership is in the statement's own WHERE", () => {
  it("refuses an edit from anyone but the sender, and after a delete", async () => {
    const { conversationId, alice, bob } = await directConversation();
    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      text: "original",
      messageType: "text",
      lastMessagePreview: "original",
    });

    expect(
      await editMessageText(db, { messageId: message.id, senderId: bob, text: "hijacked" }),
    ).toBeNull();

    const edited = await editMessageText(db, {
      messageId: message.id,
      senderId: alice,
      text: "corrected",
    });
    expect(edited?.text).toBe("corrected");
    expect(edited?.editedAt).toBeInstanceOf(Date);

    await softDeleteMessage(db, message.id, alice);
    // Mongo read, mutated and saved, so a delete landing in between resurrected
    // the text. The condition is in the UPDATE here, so there is no window.
    expect(
      await editMessageText(db, { messageId: message.id, senderId: alice, text: "zombie" }),
    ).toBeNull();
  });

  it("deletes once and reports the conversation to announce it to", async () => {
    const { conversationId, alice, bob } = await directConversation();
    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "hi",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    expect(await softDeleteMessage(db, message.id, bob)).toBeNull();
    expect(await softDeleteMessage(db, message.id, alice)).toEqual({
      id: message.id,
      conversationId,
    });
    // A second delete is a 404, not a silent success that moves the tombstone.
    expect(await softDeleteMessage(db, message.id, alice)).toBeNull();
  });
});

describe("cascades Mongo could not express", () => {
  it("takes messages and their per-recipient rows with the conversation", async () => {
    const { conversationId, alice, bob } = await directConversation();
    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "hi",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });
    await markMessageRead(db, message.id, bob);
    await toggleReaction(db, message.id, bob, "👍");

    await db.delete(schema.conversations).where(eq(schema.conversations.id, conversationId));

    expect(await findMessageById(db, message.id)).toBeNull();
    const reads = await client<{ count: string }[]>`
      select count(*) from message_reads where message_id = ${message.id}
    `;
    const reactions = await client<{ count: string }[]>`
      select count(*) from message_reactions where message_id = ${message.id}
    `;
    expect(reads[0].count).toBe("0");
    expect(reactions[0].count).toBe("0");
  });
});

describe("registering a device", () => {
  const signedPreKey = { keyId: 7, publicKey: "signed-public", signature: "sig" };

  it("reports a first registration and a re-registration differently", async () => {
    const userId = uid("user");

    const first = await registerDevice(db, {
      userId,
      deviceId: 1,
      identityKeyPublic: "identity",
      signedPreKey,
      preKeys: [{ keyId: 1, publicKey: "pk1" }],
      registrationId: 1234,
    });
    const second = await registerDevice(db, {
      userId,
      deviceId: 1,
      identityKeyPublic: "identity-rotated",
      signedPreKey: { keyId: 8, publicKey: "signed-2", signature: "sig-2" },
      preKeys: [{ keyId: 2, publicKey: "pk2" }],
      registrationId: 5678,
    });

    // `xmax = 0` distinguishes the two branches of the upsert. The route's
    // read-then-branch let two concurrent registrations both insert, and the
    // loser got a 409 for a perfectly valid request.
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.device.identityKeyPublic).toBe("identity-rotated");
    expect(second.device.signedPreKey).toEqual({
      keyId: 8,
      publicKey: "signed-2",
      signature: "sig-2",
    });
    expect(second.device.registrationId).toBe(5678);
    // One device, not two.
    expect(await listDevicesForUser(db, userId)).toHaveLength(1);
  });

  it("REPLACES the pre-key bundle rather than merging with it", async () => {
    const userId = uid("user");
    await registerDevice(db, {
      userId,
      deviceId: 1,
      identityKeyPublic: "identity",
      signedPreKey,
      preKeys: [
        { keyId: 1, publicKey: "pk1" },
        { keyId: 2, publicKey: "pk2" },
      ],
      registrationId: 1,
    });

    await registerDevice(db, {
      userId,
      deviceId: 1,
      identityKeyPublic: "identity",
      signedPreKey,
      preKeys: [{ keyId: 9, publicKey: "pk9" }],
      registrationId: 1,
    });

    // A client rotating its bundle is not merging with what the server held —
    // and `unique(device_id, key_id)` would refuse a merge that reused an id.
    expect(await findDevicePreKeys(db, userId, 1)).toEqual([{ keyId: 9, publicKey: "pk9" }]);
  });

  it("keeps two users' device number 1 apart", async () => {
    const first = uid("user");
    const second = uid("user");
    await registerDevice(db, {
      userId: first,
      deviceId: 1,
      identityKeyPublic: "a",
      signedPreKey,
      preKeys: [],
      registrationId: 1,
    });
    await registerDevice(db, {
      userId: second,
      deviceId: 1,
      identityKeyPublic: "b",
      signedPreKey,
      preKeys: [],
      registrationId: 2,
    });

    // Signal's device number is unique only WITHIN a user.
    expect((await findDevice(db, first, 1))?.identityKeyPublic).toBe("a");
    expect((await findDevice(db, second, 1))?.identityKeyPublic).toBe("b");
  });
});

describe("what each device projection does and does not carry", () => {
  const signedPreKey = { keyId: 3, publicKey: "signed-public", signature: "sig" };

  it("keeps one-time pre-keys out of the list, which is what -preKeys did", async () => {
    const userId = uid("user");
    await registerDevice(db, {
      userId,
      deviceId: 1,
      identityKeyPublic: "identity",
      signedPreKey,
      preKeys: [{ keyId: 1, publicKey: "pk1" }],
      registrationId: 1,
    });

    const listed = await listDevicesForUser(db, userId);
    expect(listed).toHaveLength(1);
    // A child table now, so the list cannot leak them: it never reads them.
    expect(Object.keys(listed[0])).not.toContain("preKeys");
    expect(listed[0].signedPreKey).toEqual(signedPreKey);
  });

  it("gives a stranger the bundle without the owner's identity or timestamps", async () => {
    const userId = uid("user");
    await registerDevice(db, {
      userId,
      deviceId: 1,
      identityKeyPublic: "identity",
      signedPreKey,
      preKeys: [{ keyId: 1, publicKey: "pk1" }],
      registrationId: 99,
    });

    const bundles = await listDeviceBundlesForUser(db, userId);
    expect(bundles).toHaveLength(1);
    expect(Object.keys(bundles[0]).sort()).toEqual(
      ["deviceId", "id", "identityKeyPublic", "registrationId", "signedPreKey"].sort(),
    );
    expect(bundles[0].signedPreKey).toEqual(signedPreKey);
  });

  it("orders devices by Signal's own number", async () => {
    const userId = uid("user");
    for (const deviceId of [3, 1, 2]) {
      await registerDevice(db, {
        userId,
        deviceId,
        identityKeyPublic: `identity-${String(deviceId)}`,
        signedPreKey,
        preKeys: [],
        registrationId: deviceId,
      });
    }
    expect((await listDevicesForUser(db, userId)).map((d) => d.deviceId)).toEqual([1, 2, 3]);
  });

  it("tells an unknown device apart from one with no pre-keys left", async () => {
    const userId = uid("user");
    await registerDevice(db, {
      userId,
      deviceId: 1,
      identityKeyPublic: "identity",
      signedPreKey,
      preKeys: [],
      registrationId: 1,
    });

    // An exhausted bundle and a wrong device id are different answers; only the
    // second is a 404.
    expect(await findDevicePreKeys(db, userId, 1)).toEqual([]);
    expect(await findDevicePreKeys(db, userId, 2)).toBeNull();
  });
});

describe("updating and removing a device", () => {
  const signedPreKey = { keyId: 5, publicKey: "signed-public", signature: "sig" };

  it("applies only the fields named and leaves stored pre-keys alone when absent", async () => {
    const userId = uid("user");
    await registerDevice(db, {
      userId,
      deviceId: 1,
      identityKeyPublic: "identity",
      signedPreKey,
      preKeys: [{ keyId: 1, publicKey: "pk1" }],
      registrationId: 1,
    });

    const updated = await updateDeviceKeys(db, userId, 1, { registrationId: 42 });
    expect(updated?.registrationId).toBe(42);
    expect(updated?.identityKeyPublic).toBe("identity");
    // `undefined` leaves the bundle alone; an empty array would clear it.
    expect(updated?.preKeys).toEqual([{ keyId: 1, publicKey: "pk1" }]);

    const cleared = await updateDeviceKeys(db, userId, 1, { preKeys: [] });
    expect(cleared?.preKeys).toEqual([]);

    expect(await updateDeviceKeys(db, userId, 99, { registrationId: 1 })).toBeNull();
  });

  it("takes the pre-keys with the device", async () => {
    const userId = uid("user");
    const registered = await registerDevice(db, {
      userId,
      deviceId: 1,
      identityKeyPublic: "identity",
      signedPreKey,
      preKeys: [{ keyId: 1, publicKey: "pk1" }],
      registrationId: 1,
    });

    expect(await deleteDevice(db, userId, 1)).toBe(true);
    const orphans = await client<{ count: string }[]>`
      select count(*) from device_pre_keys where device_id = ${registered.device.id}
    `;
    expect(orphans[0].count).toBe("0");
    expect(await deleteDevice(db, userId, 1)).toBe(false);
  });
});

/**
 * The DTOs, against rows a real conversation produced.
 *
 * These belong beside the repositories rather than in a unit test over a
 * hand-built record, and the reason is the failure they exist to catch. The
 * whole risk in `unreadCounts` is that the number stops coming from
 * `conversation_participants.unread_count` — because the repository stopped
 * selecting it, because the column stopped being incremented, or because the
 * serializer stopped reading it. A fabricated `ConversationRecord` would carry
 * whatever the test author typed and would keep passing through all three.
 */
describe("the conversation DTO, which reassembles what the schema took apart", () => {
  it("rebuilds unreadCounts from the participant rows, keyed by user id", async () => {
    const alice = uid("alice");
    const bob = uid("bob");
    const carol = uid("carol");

    const group = await createConversation(db, {
      type: "group",
      createdBy: alice,
      participants: [
        { userId: alice, role: "admin" },
        { userId: bob, role: "member" },
        { userId: carol, role: "member" },
      ],
    });

    for (const preview of ["first", "second"]) {
      await createMessage(db, {
        conversationId: group.id,
        senderId: alice,
        senderDeviceId: 1,
        ciphertext: `cipher-${preview}`,
        messageType: "text",
        lastMessagePreview: "[Encrypted]",
      });
    }

    // Bob reads; Carol does not. Alice never had a count to begin with.
    await markConversationRead(db, group.id, bob);

    const record = await findConversationForParticipant(db, group.id, alice);
    if (!record) throw new Error("the conversation vanished");

    const dto = toConversationDto(record, record.participants.map(toConversationParticipant));

    /**
     * THREE distinct values, deliberately. With every participant on the same
     * number this assertion could not tell "read each person's own row" from
     * "give everyone the same total" or "give everyone zero" — the exact
     * mistakes that make every unread badge in the app read zero while the
     * response stays a valid 200.
     */
    expect(dto.unreadCounts).toEqual({ [alice]: 0, [bob]: 0, [carol]: 2 });
  });

  it("drops archivedBy entirely, rather than reporting who archived", async () => {
    const { conversationId, alice, bob } = await directConversation();

    expect(await setConversationArchived(db, conversationId, bob, true)).toBe(true);

    const record = await findConversationForParticipant(db, conversationId, alice);
    if (!record) throw new Error("the conversation vanished");

    const dto = toConversationDto(record, record.participants.map(toConversationParticipant));

    // Not merely absent from the type — absent from the emitted object, so
    // Bob's archival is not disclosed to Alice under any key.
    expect("archivedBy" in dto).toBe(false);
    expect(JSON.stringify(dto)).not.toContain("archived");
  });

  it("emits id and the _id its shipped clients read, and they agree", async () => {
    const { conversationId, alice } = await directConversation();

    const record = await findConversationForParticipant(db, conversationId, alice);
    if (!record) throw new Error("the conversation vanished");

    const dto = toConversationDto(record, record.participants.map(toConversationParticipant));

    expect(dto.id).toBe(conversationId);
    expect(dto._id).toBe(conversationId);
  });
});

describe("the message DTO", () => {
  it("emits id and _id, and carries the keyed collections even when empty", async () => {
    const { conversationId, alice, bob } = await directConversation();

    const message = await createMessage(db, {
      conversationId,
      senderId: alice,
      senderDeviceId: 1,
      ciphertext: "cipher",
      messageType: "text",
      lastMessagePreview: "[Encrypted]",
    });

    const fresh = toMessageDto(message);
    expect(fresh.id).toBe(message.id);
    expect(fresh._id).toBe(message.id);
    // Empty rather than absent: a receipt collection that changes shape when it
    // reaches zero is not something a client should have to handle.
    expect(fresh.readBy).toEqual({});
    expect(fresh.reactions).toEqual({});
    // The sender's own delivery, written with the message in one transaction.
    expect(fresh.deliveredTo).toEqual([alice]);

    await markMessageRead(db, message.id, bob);
    await toggleReaction(db, message.id, bob, "🎉");

    const hydrated = await findMessageById(db, message.id);
    if (!hydrated) throw new Error("the message vanished");
    const dto = toMessageDto(hydrated);

    expect(Object.keys(dto.readBy ?? {})).toEqual([bob]);
    expect(dto.reactions).toEqual({ "🎉": [bob] });
  });
});
