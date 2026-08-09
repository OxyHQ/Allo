/**
 * Messages and the per-recipient state hanging off them.
 *
 * Ported from `models/Message.ts`. The one decision that shapes this whole file
 * is that the two media arrays stay ON the message row — see `CONVENTIONS.md`
 * §"The two Mongoose hooks" for why, and what it buys.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, updatedAt } from "@oxyhq/db";
import { checkOneOf } from "./columns";
import { conversations } from "./conversations";

export const MESSAGE_KINDS = ["text", "media", "system"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * A message.
 *
 * **`conversationId` is a real foreign key**, which Mongo could not express: a
 * deleted conversation there left its messages behind and nothing ever collected
 * them. `ON DELETE CASCADE` is correct for an encrypted messenger — the messages
 * are unreadable without the conversation's session state anyway, and keeping
 * ciphertext nobody can decrypt is retention without a purpose.
 *
 * `replyTo` is deliberately NOT a foreign key. It points at another message that
 * may already have been deleted, and a reply must outlive the message it answers
 * — Mongo's `ref` was never enforced either, so a FK here would be a NEW
 * restriction introduced by the port rather than a preserved one.
 */
export const messages = pgTable(
  "messages",
  {
    id: text().primaryKey(),
    conversationId: text()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    senderId: text().notNull(),
    /** Which of the sender's Signal devices produced this ciphertext. */
    senderDeviceId: integer().notNull(),

    /** Base64 Signal ciphertext. */
    ciphertext: text(),
    /**
     * Encrypted media descriptors, as written by the client.
     *
     * `jsonb`, not a child table: each entry is an opaque envelope around
     * ciphertext the server cannot read, no query ever reaches inside one, and
     * keeping it on the row is what lets the content invariant below be a CHECK
     * instead of a trigger.
     */
    encryptedMedia: jsonb().notNull().default([]),
    encryptionVersion: integer().notNull().default(1),
    messageType: text({ enum: MESSAGE_KINDS }).notNull().default("text"),

    /** Legacy plaintext, from before encryption. Retained, never written anew. */
    text: text(),
    media: jsonb().notNull().default([]),

    replyTo: text(),
    fontSize: integer(),
    editedAt: timestamptz(),
    deletedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("messages_conversation_id_created_at_idx").on(t.conversationId, t.createdAt),
    index("messages_sender_id_created_at_idx").on(t.senderId, t.createdAt),
    index("messages_conversation_id_deleted_at_created_at_idx").on(
      t.conversationId,
      t.deletedAt,
      t.createdAt,
    ),
    checkOneOf("messages_message_type_check", t.messageType, MESSAGE_KINDS),
    /**
     * `Message.pre('save')`, expressed structurally.
     *
     * A message must carry encrypted content OR legacy plaintext. This is the
     * whole hook, and it holds for every writer — including a backfill, a repair
     * script and a future repository nobody has written yet, none of which would
     * have gone through the hook.
     *
     * It deliberately does NOT forbid ciphertext and plaintext together: the
     * hook only `console.warn`ed about that, so refusing it here would be a new
     * restriction discovered in production by whatever legacy row still has
     * both.
     */
    check(
      "messages_content_present_check",
      sql`${t.ciphertext} is not null
        or jsonb_array_length(${t.encryptedMedia}) > 0
        or ${t.text} is not null
        or jsonb_array_length(${t.media}) > 0`,
    ),
    /** Both media columns are arrays, so `jsonb_array_length` above cannot error. */
    check(
      "messages_media_is_array_check",
      sql`jsonb_typeof(${t.encryptedMedia}) = 'array' and jsonb_typeof(${t.media}) = 'array'`,
    ),
    check("messages_font_size_range_check", sql`${t.fontSize} between 10 and 72`),
    check("messages_sender_device_id_check", sql`${t.senderDeviceId} >= 1`),
  ],
);

/**
 * `readBy`, a `Map<userId, Date>`, as rows.
 *
 * A child table rather than `jsonb` because this one IS queried per user (has
 * this person read this message) and grows with the conversation's membership;
 * the unique index gives read receipts idempotency the Map got from its key.
 */
export const messageReads = pgTable(
  "message_reads",
  {
    id: text().primaryKey(),
    messageId: text()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text().notNull(),
    readAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_reads_message_id_user_id_key").on(t.messageId, t.userId),
  ],
);

/** `deliveredTo`, an array of user ids, as rows — same reasoning as {@link messageReads}. */
export const messageDeliveries = pgTable(
  "message_deliveries",
  {
    id: text().primaryKey(),
    messageId: text()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text().notNull(),
    deliveredAt: timestamptz().notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("message_deliveries_message_id_user_id_key").on(t.messageId, t.userId),
  ],
);

/**
 * `reactions`, a `Map<emoji, userId[]>`, as one row per (message, user, emoji).
 *
 * The Map could hold the same user id twice in one emoji's array; the unique
 * index makes a repeated reaction converge instead of accumulating.
 */
export const messageReactions = pgTable(
  "message_reactions",
  {
    id: text().primaryKey(),
    messageId: text()
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: text().notNull(),
    emoji: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("message_reactions_message_id_user_id_emoji_key").on(
      t.messageId,
      t.userId,
      t.emoji,
    ),
    index("message_reactions_message_id_idx").on(t.messageId),
  ],
);
