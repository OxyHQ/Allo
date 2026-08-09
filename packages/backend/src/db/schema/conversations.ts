/**
 * Conversations and their participants.
 *
 * Ported from `models/Conversation.ts`. The participant array becomes a child
 * table, which is what turns `Conversation.pre('save')` from an application hook
 * into a database constraint — see `CONVENTIONS.md` §"The two Mongoose hooks".
 */

import { index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, updatedAt } from "@oxyhq/db";
import { checkOneOf } from "./columns";

export const CONVERSATION_TYPES = ["direct", "group"] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

export const CONVERSATION_PARTICIPANT_ROLES = ["admin", "member"] as const;
export type ConversationParticipantRole = (typeof CONVERSATION_PARTICIPANT_ROLES)[number];

/**
 * The embedded `lastMessage` becomes three columns.
 *
 * It is a denormalised preview maintained by the write path, not a reference —
 * deliberately NOT a foreign key to `messages`, because the preview must survive
 * the message being deleted, which is exactly when a FK would either block the
 * delete or null the preview out.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: text().primaryKey(),
    type: text({ enum: CONVERSATION_TYPES }).notNull(),
    name: text(),
    description: text(),
    avatar: text(),
    /** Colour theme id, shared by every participant. */
    theme: text(),
    createdBy: text().notNull(),
    lastMessageAt: timestamptz(),
    lastMessageText: text(),
    lastMessageSenderId: text(),
    lastMessageTimestamp: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("conversations_created_by_last_message_at_idx").on(t.createdBy, t.lastMessageAt),
    index("conversations_type_last_message_at_idx").on(t.type, t.lastMessageAt),
    checkOneOf("conversations_type_check", t.type, CONVERSATION_TYPES),
  ],
);

/**
 * One person's membership of one conversation.
 *
 * Three Mongo structures collapse into this row, because all three were keyed by
 * participant and only ever read for a participant who is already in the array:
 *
 * - the `participants[]` entry itself (`role`, `joinedAt`, `lastReadAt`);
 * - `unreadCounts`, a `Map<userId, number>` → `unreadCount`;
 * - `archivedBy`, an array of user ids → `archivedAt`.
 *
 * Keeping `archivedBy` as a list on the conversation would let a user id appear
 * there while not being a participant at all; as a column on the membership row
 * that state is unrepresentable. `archivedAt` rather than a boolean because the
 * timestamp answers "since when" for free and still reads as a flag.
 *
 * The unique index is what `participants.userId` was doing in Mongo — one
 * membership per person per conversation, which the embedded array could not
 * enforce.
 */
export const conversationParticipants = pgTable(
  "conversation_participants",
  {
    id: text().primaryKey(),
    conversationId: text()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text().notNull(),
    role: text({ enum: CONVERSATION_PARTICIPANT_ROLES }).notNull().default("member"),
    joinedAt: timestamptz().notNull().defaultNow(),
    lastReadAt: timestamptz(),
    unreadCount: integer().notNull().default(0),
    archivedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversation_participants_conversation_id_user_id_key").on(
      t.conversationId,
      t.userId,
    ),
    /** Drives the conversation list: every conversation a person is in, newest first. */
    index("conversation_participants_user_id_idx").on(t.userId),
    checkOneOf(
      "conversation_participants_role_check",
      t.role,
      CONVERSATION_PARTICIPANT_ROLES,
    ),
  ],
);
