/**
 * Messages and the per-recipient state hanging off them, as Postgres.
 *
 * Ported from what `routes/messages.ts` asks `models/Message.ts` for — fourteen
 * call sites, no more.
 *
 * ## Protected columns are opted into BY NAME, here
 *
 * `messages` registers `ciphertext`, `encryptedMedia`, `text` and `media` in
 * `db/protectedColumns.ts`, and the registry's rule is that a path legitimately
 * needing one names it explicitly rather than reaching it through a bare
 * `db.select().from(messages)`. This file is that path — it IS the messaging
 * service, and the ciphertext is the message — so {@link MESSAGE_COLUMNS} spells
 * every column out. That is the whole opt-in, and it stays greppable: a reader
 * asking "who can read ciphertext" finds this constant and nothing else.
 *
 * ## The two Mongo `Map`s did NOT have the same semantics, and both are kept
 *
 * `readBy.set(userId, new Date())` OVERWROTE the timestamp on every repeat,
 * while `deliveredTo` was pushed only `if (!includes(userId))` — first write
 * wins. The port preserves the asymmetry rather than tidying it (see
 * {@link markMessageRead} and {@link markMessageDelivered}), because "the read
 * receipt should show when they FIRST read it" is a product change, not a
 * porting decision, and it is not this change's to make.
 */

import { and, asc, desc, eq, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { uuidv7, type SelectedRow } from "@oxyhq/db";
import { publicColumns } from "@oxyhq/db/assert";
import type {
  EncryptedMediaItem,
  MediaItem,
  MessageKind,
} from "@allo/shared-types";
import type { AlloDatabase } from "../index";
import { PROTECTED_COLUMNS } from "../protectedColumns";
import { conversationParticipants, conversations } from "../schema/conversations";
import {
  messageDeliveries,
  messageReactions,
  messageReads,
  messages,
} from "../schema/messages";

/**
 * Every column of `messages`, protected ones included and NAMED.
 *
 * Written out rather than produced by a helper: the registry's contract is that
 * opting in "must read differently from an ordinary select", and a helper that
 * re-included protected columns would make every call site look ordinary again.
 */
const MESSAGE_COLUMNS = {
  id: messages.id,
  conversationId: messages.conversationId,
  senderId: messages.senderId,
  senderDeviceId: messages.senderDeviceId,
  ciphertext: messages.ciphertext,
  encryptedMedia: messages.encryptedMedia,
  encryptionVersion: messages.encryptionVersion,
  messageType: messages.messageType,
  text: messages.text,
  media: messages.media,
  replyTo: messages.replyTo,
  fontSize: messages.fontSize,
  editedAt: messages.editedAt,
  deletedAt: messages.deletedAt,
  createdAt: messages.createdAt,
  updatedAt: messages.updatedAt,
} as const;

/** None of the three per-recipient tables registers a protected column. */
const READ_COLUMNS = publicColumns(messageReads, PROTECTED_COLUMNS);
const DELIVERY_COLUMNS = publicColumns(messageDeliveries, PROTECTED_COLUMNS);
const REACTION_COLUMNS = publicColumns(messageReactions, PROTECTED_COLUMNS);

type MessageRow = SelectedRow<typeof MESSAGE_COLUMNS>;

/**
 * A message with the three per-recipient collections folded back in.
 *
 * `readBy` and `reactions` are keyed collections rather than rows because that
 * is what they were before the port — Mongo `Map`s whose keys the unique indexes
 * now carry — and a reaction bar reads them exactly that way. This is the
 * opposite of the conversation repository's choice for `unreadCounts` /
 * `archivedBy`, and the reason differs too: those collapsed ONTO an existing row
 * that is itself part of the result, whereas these three have no other home.
 */
export interface MessageRecord {
  readonly id: string;
  readonly conversationId: string;
  readonly senderId: string;
  readonly senderDeviceId: number;
  readonly ciphertext: string | null;
  readonly encryptedMedia: readonly EncryptedMediaItem[];
  readonly encryptionVersion: number;
  readonly messageType: MessageKind;
  readonly text: string | null;
  readonly media: readonly MediaItem[];
  readonly replyTo: string | null;
  readonly fontSize: number | null;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
  /** userId -> when they read it. */
  readonly readBy: Readonly<Record<string, Date>>;
  /** userIds who received it, oldest first. */
  readonly deliveredTo: readonly string[];
  /** emoji -> the userIds who reacted with it, oldest first. */
  readonly reactions: Readonly<Record<string, readonly string[]>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Cross `jsonb`'s `unknown` into the media types.
 *
 * The array-ness is guaranteed by `messages_media_is_array_check`, so the guard
 * is a statement of that invariant rather than a branch anyone expects to take;
 * it throws instead of coercing, because silently substituting `[]` for a shape
 * this code did not anticipate would delete a user's media rather than report a
 * broken row.
 *
 * The ELEMENT type is asserted, deliberately. The write path validates every
 * item before it is stored (`parseMediaItem` / `parseEncryptedMediaItem` in
 * `routes/messages.ts`), and re-validating on READ would make a legacy row that
 * predates those parsers unreadable — a new restriction introduced by the port,
 * of exactly the kind `messages_content_present_check` was written to avoid.
 */
function mediaArray<T>(value: unknown, column: string, messageId: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `messages.${column} is not a JSON array on message ${messageId}; ` +
        "messages_media_is_array_check should have made this unreachable",
    );
  }
  return value as T[];
}

interface PerRecipientState {
  readonly readBy: Record<string, Date>;
  readonly deliveredTo: string[];
  readonly reactions: Record<string, string[]>;
}

function emptyState(): PerRecipientState {
  return { readBy: {}, deliveredTo: [], reactions: {} };
}

function toMessageRecord(row: MessageRow, state: PerRecipientState): MessageRecord {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderId: row.senderId,
    senderDeviceId: row.senderDeviceId,
    ciphertext: row.ciphertext,
    encryptedMedia: mediaArray<EncryptedMediaItem>(row.encryptedMedia, "encrypted_media", row.id),
    encryptionVersion: row.encryptionVersion,
    messageType: row.messageType,
    text: row.text,
    media: mediaArray<MediaItem>(row.media, "media", row.id),
    replyTo: row.replyTo,
    fontSize: row.fontSize,
    editedAt: row.editedAt,
    deletedAt: row.deletedAt,
    readBy: state.readBy,
    deliveredTo: state.deliveredTo,
    reactions: state.reactions,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The three child tables for a whole page of messages, in three queries rather
 * than three per message. A fifty-message page is the common case, and the N+1
 * version of this is 150 round trips for one screen.
 */
async function loadPerRecipientState(
  db: AlloDatabase,
  messageIds: readonly string[],
): Promise<Map<string, PerRecipientState>> {
  const byMessage = new Map<string, PerRecipientState>();
  if (messageIds.length === 0) return byMessage;

  const ids = [...messageIds];
  for (const id of ids) byMessage.set(id, emptyState());

  const [reads, deliveries, reactions] = await Promise.all([
    db
      .select(READ_COLUMNS)
      .from(messageReads)
      .where(inArray(messageReads.messageId, ids)),
    db
      .select(DELIVERY_COLUMNS)
      .from(messageDeliveries)
      .where(inArray(messageDeliveries.messageId, ids))
      // Mongo's `deliveredTo` was an array appended to in order.
      .orderBy(asc(messageDeliveries.deliveredAt), asc(messageDeliveries.id)),
    db
      .select(REACTION_COLUMNS)
      .from(messageReactions)
      .where(inArray(messageReactions.messageId, ids))
      .orderBy(asc(messageReactions.createdAt), asc(messageReactions.id)),
  ]);

  for (const read of reads) {
    const state = byMessage.get(read.messageId);
    if (state) state.readBy[read.userId] = read.readAt;
  }
  for (const delivery of deliveries) {
    const state = byMessage.get(delivery.messageId);
    if (state) state.deliveredTo.push(delivery.userId);
  }
  for (const reaction of reactions) {
    const state = byMessage.get(reaction.messageId);
    if (!state) continue;
    const existing = state.reactions[reaction.emoji];
    if (existing) existing.push(reaction.userId);
    else state.reactions[reaction.emoji] = [reaction.userId];
  }

  return byMessage;
}

async function hydrate(
  db: AlloDatabase,
  rows: readonly MessageRow[],
): Promise<MessageRecord[]> {
  const state = await loadPerRecipientState(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toMessageRecord(row, state.get(row.id) ?? emptyState()));
}

export interface ListMessagesInput {
  readonly conversationId: string;
  readonly limit: number;
  /** Exclusive upper bound on `createdAt`, for "load older". */
  readonly before?: Date;
}

/**
 * A page of a conversation's messages, oldest-first.
 *
 * The SQL orders NEWEST first because the page wanted is the most recent `limit`
 * before the cursor, and the result is then reversed for the caller — which is
 * what the route did by hand with `messages.reverse()`.
 *
 * `id` is a tiebreaker the Mongo query did not have. Two messages sharing a
 * `createdAt` had no defined order there, so a paging client could see one twice
 * and never see the other; both id shapes this schema stores are time-ordered
 * (uuid v7, and an ObjectId hex whose leading bytes are a timestamp), so
 * ordering by it after `createdAt` is stable and agrees with the primary sort.
 */
export async function listConversationMessages(
  db: AlloDatabase,
  input: ListMessagesInput,
): Promise<MessageRecord[]> {
  const rows = await db
    .select(MESSAGE_COLUMNS)
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, input.conversationId),
        // Mongo asked for `deletedAt: {$exists: false}`; a soft-deleted message
        // is excluded, not returned tombstoned.
        isNull(messages.deletedAt),
        input.before ? lt(messages.createdAt, input.before) : undefined,
      ),
    )
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(input.limit);

  const hydrated = await hydrate(db, rows);
  return hydrated.reverse();
}

/**
 * One message by id, soft-deleted ones included.
 *
 * `Message.findById` did not filter on `deletedAt`, and three routes rely on
 * that: they fetch the message to learn its `conversationId` before deciding
 * whether the caller may see it at all.
 */
export async function findMessageById(
  db: AlloDatabase,
  messageId: string,
): Promise<MessageRecord | null> {
  const rows = await db
    .select(MESSAGE_COLUMNS)
    .from(messages)
    .where(eq(messages.id, messageId))
    .limit(1);
  const hydrated = await hydrate(db, rows);
  return hydrated[0] ?? null;
}

export interface CreateMessageInput {
  readonly conversationId: string;
  readonly senderId: string;
  readonly senderDeviceId: number;
  readonly ciphertext?: string | null;
  readonly encryptedMedia?: readonly EncryptedMediaItem[];
  readonly encryptionVersion?: number;
  readonly messageType: MessageKind;
  readonly text?: string | null;
  readonly media?: readonly MediaItem[];
  readonly replyTo?: string | null;
  readonly fontSize?: number | null;
  /**
   * The conversation-list preview.
   *
   * The CALLER composes it, because what a preview may contain is a privacy
   * decision rather than a storage one: an encrypted message stores a
   * placeholder and never its plaintext. A repository that derived this would be
   * deciding that policy for every future caller.
   */
  readonly lastMessagePreview: string | null;
}

/**
 * Send a message: the row, the sender's own delivery receipt, the conversation
 * preview and everyone else's unread count — in ONE transaction.
 *
 * Mongo did these as two independent saves, so a failure between them left a
 * stored message the conversation list never showed. They commit together here.
 *
 * The unread increment is `unread_count = unread_count + 1` IN SQL rather than a
 * read-modify-write, and it is worth being precise about what that buys, because
 * the obvious answer is wrong. It is NOT needed to make two concurrent SENDS
 * safe: both transactions update the conversation row first, so the second
 * blocks there until the first commits, and a read-modify-write would reach the
 * same total. Mutation-tested — replacing this with a select-then-update leaves
 * the concurrent-send case green.
 *
 * What it actually protects is a writer that touches the PARTICIPANT row without
 * touching the conversation row, which is exactly `markConversationRead`. A
 * read-modify-write reads the backlog, blocks on the row lock, and then writes
 * `stale + 1` over the zero a reader just committed — the badge reappears on a
 * conversation the user has read. Evaluated in SQL, the addition re-reads the
 * committed value and the receipt survives.
 */
export async function createMessage(
  db: AlloDatabase,
  input: CreateMessageInput,
): Promise<MessageRecord> {
  const messageId = uuidv7();

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(messages)
      .values({
        id: messageId,
        conversationId: input.conversationId,
        senderId: input.senderId,
        senderDeviceId: input.senderDeviceId,
        ciphertext: input.ciphertext ?? null,
        encryptedMedia: input.encryptedMedia ? [...input.encryptedMedia] : [],
        encryptionVersion: input.encryptionVersion ?? 1,
        messageType: input.messageType,
        text: input.text ?? null,
        media: input.media ? [...input.media] : [],
        replyTo: input.replyTo ?? null,
        fontSize: input.fontSize ?? null,
      })
      .returning(MESSAGE_COLUMNS);

    const row = inserted[0];
    if (!row) throw new Error(`Message ${messageId} produced no row on insert`);

    // Mongo created the message with `deliveredTo: [senderId]` — a sender has by
    // definition received their own message.
    await tx.insert(messageDeliveries).values({
      id: uuidv7(),
      messageId,
      userId: input.senderId,
    });

    // The message's own `created_at` rather than a second `new Date()`: the
    // preview's timestamp IS the message's, and two clocks read moments apart
    // can only disagree.
    await tx
      .update(conversations)
      .set({
        lastMessageAt: row.createdAt,
        lastMessageText: input.lastMessagePreview,
        lastMessageSenderId: input.senderId,
        lastMessageTimestamp: row.createdAt,
      })
      .where(eq(conversations.id, input.conversationId));

    await tx
      .update(conversationParticipants)
      .set({ unreadCount: sql`${conversationParticipants.unreadCount} + 1` })
      .where(
        and(
          eq(conversationParticipants.conversationId, input.conversationId),
          ne(conversationParticipants.userId, input.senderId),
        ),
      );

    return toMessageRecord(row, {
      readBy: {},
      deliveredTo: [input.senderId],
      reactions: {},
    });
  });
}

export interface EditMessageInput {
  readonly messageId: string;
  /** The sender, as the OWNERSHIP predicate — never taken from the row. */
  readonly senderId: string;
  readonly text: string;
}

/**
 * Edit a message's text.
 *
 * The ownership and not-deleted conditions are in the UPDATE's own `WHERE`, so
 * there is no window between checking and writing: Mongo read the document,
 * mutated it and saved, which let a delete land in between and resurrect the
 * message's text. `null` means no row matched — the route's single 404 for "no
 * such message", "not yours" and "already deleted", which deliberately tells an
 * unauthorized caller nothing about which one it was.
 */
export async function editMessageText(
  db: AlloDatabase,
  input: EditMessageInput,
): Promise<MessageRecord | null> {
  const rows = await db
    .update(messages)
    .set({ text: input.text, editedAt: new Date() })
    .where(
      and(
        eq(messages.id, input.messageId),
        eq(messages.senderId, input.senderId),
        isNull(messages.deletedAt),
      ),
    )
    .returning(MESSAGE_COLUMNS);

  const hydrated = await hydrate(db, rows);
  return hydrated[0] ?? null;
}

export interface DeletedMessage {
  readonly id: string;
  /** The room the caller has to emit the deletion to. */
  readonly conversationId: string;
}

/**
 * Soft-delete a message. Same single-statement ownership check as
 * {@link editMessageText}, and `isNull(deletedAt)` is what makes a second delete
 * a 404 rather than a silent success that moves the tombstone's timestamp.
 */
export async function softDeleteMessage(
  db: AlloDatabase,
  messageId: string,
  senderId: string,
): Promise<DeletedMessage | null> {
  const rows = await db
    .update(messages)
    .set({ deletedAt: new Date() })
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.senderId, senderId),
        isNull(messages.deletedAt),
      ),
    )
    .returning({ id: messages.id, conversationId: messages.conversationId });

  return rows[0] ?? null;
}

/**
 * Record a read receipt.
 *
 * `ON CONFLICT ... DO UPDATE` on `message_reads_message_id_user_id_key`. The
 * conflict target is the idempotency: the Map's key gave it for free, and
 * without the index this would be the read-then-write that lets two concurrent
 * receipts insert two rows for one person.
 *
 * The timestamp is OVERWRITTEN on a repeat, which is what
 * `readBy.set(userId, new Date())` did. Keeping the FIRST read instant is very
 * likely what a receipt should mean, and switching to `DO NOTHING` is the whole
 * change — but it is a product decision about what the ✓✓ claims, so the port
 * reproduces the source and leaves it visible here rather than altering it in
 * passing.
 */
export async function markMessageRead(
  db: AlloDatabase,
  messageId: string,
  userId: string,
): Promise<MessageRecord | null> {
  const readAt = new Date();
  await db
    .insert(messageReads)
    .values({ id: uuidv7(), messageId, userId, readAt })
    .onConflictDoUpdate({
      target: [messageReads.messageId, messageReads.userId],
      set: { readAt },
    });

  return findMessageById(db, messageId);
}

/**
 * Record a delivery receipt.
 *
 * `DO NOTHING`, not `DO UPDATE` — and the difference from
 * {@link markMessageRead} is inherited, not invented: Mongo pushed onto
 * `deliveredTo` only `if (!deliveredTo.includes(userId))`, so the FIRST delivery
 * instant is the one it kept.
 */
export async function markMessageDelivered(
  db: AlloDatabase,
  messageId: string,
  userId: string,
): Promise<MessageRecord | null> {
  await db
    .insert(messageDeliveries)
    .values({ id: uuidv7(), messageId, userId })
    .onConflictDoNothing({
      target: [messageDeliveries.messageId, messageDeliveries.userId],
    });

  return findMessageById(db, messageId);
}

export interface ReactionToggle {
  /** The caller's state AFTER the toggle — what the route reports and emits. */
  readonly hasReacted: boolean;
  readonly reactions: Readonly<Record<string, readonly string[]>>;
}

/**
 * Add the caller's reaction, or take it away if it is already there.
 *
 * Mongo read the whole `Map<emoji, userId[]>`, edited it in memory and saved it
 * back, so two people reacting at once wrote over each other — one reaction
 * simply vanished, and the Map could also hold the same user twice within one
 * emoji. Deleting or inserting a single row against
 * `message_reactions_message_id_user_id_emoji_key` has neither problem.
 *
 * The whole toggle plus the re-read run in one transaction so the returned map
 * is the state this toggle produced, not one a concurrent reaction has already
 * moved past.
 *
 * ## One divergence from Mongo, and it is forced rather than chosen
 *
 * Removing the LAST reactor for an emoji drops that emoji's key from the map
 * entirely. Mongo kept it, because the route removed a reaction with
 * `reactions.set(emoji, filtered)` and never `reactions.delete(emoji)` — so an
 * emoji that had ever been used stayed in the document forever as `[]`, and
 * `save()` wrote that empty array back.
 *
 * There is no row that could reproduce it here. The table's grain is
 * (message, user, emoji), so "this emoji has zero reactors" has nothing to be a
 * row OF — carrying it would take a second table or a tombstone column existing
 * solely to preserve an artefact of how the Map happened to be edited. The
 * behaviour is pinned by a test rather than left to be rediscovered, and a
 * client must treat a missing key and an empty array as the same thing.
 */
export async function toggleReaction(
  db: AlloDatabase,
  messageId: string,
  userId: string,
  emoji: string,
): Promise<ReactionToggle> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(messageReactions)
      .where(
        and(
          eq(messageReactions.messageId, messageId),
          eq(messageReactions.userId, userId),
          eq(messageReactions.emoji, emoji),
        ),
      )
      .returning({ id: messageReactions.id });

    const hasReacted = removed.length === 0;
    if (hasReacted) {
      await tx
        .insert(messageReactions)
        .values({ id: uuidv7(), messageId, userId, emoji })
        .onConflictDoNothing({
          target: [messageReactions.messageId, messageReactions.userId, messageReactions.emoji],
        });
    }

    const rows = await tx
      .select(REACTION_COLUMNS)
      .from(messageReactions)
      .where(eq(messageReactions.messageId, messageId))
      .orderBy(asc(messageReactions.createdAt), asc(messageReactions.id));

    const reactions: Record<string, string[]> = {};
    for (const row of rows) {
      const existing = reactions[row.emoji];
      if (existing) existing.push(row.userId);
      else reactions[row.emoji] = [row.userId];
    }

    return { hasReacted, reactions };
  });
}
