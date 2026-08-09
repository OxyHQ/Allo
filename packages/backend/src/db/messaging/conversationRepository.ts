/**
 * Conversations and their participants, as Postgres.
 *
 * Ported from what `routes/conversations.ts` asks `models/Conversation.ts` for —
 * ten call sites, no more. There is deliberately no generic CRUD surface here:
 * a function nobody calls is a function nothing pins, and this file lands unused
 * on purpose (the call-site switch is a separate change).
 *
 * ## The transaction is not a style choice
 *
 * `conversations_participant_count_check` is a `DEFERRABLE INITIALLY DEFERRED`
 * constraint trigger judged at COMMIT (see `schema/CONVENTIONS.md` §"The two
 * Mongoose hooks"). A conversation necessarily exists for a moment before its
 * participants do, so {@link createConversation} takes the participants WITH the
 * conversation and writes both inside one `db.transaction(...)`. An API that let
 * a caller insert a conversation alone would be an API whose every use fails at
 * commit.
 *
 * ## What this file deliberately does NOT rebuild
 *
 * Mongo's conversation carried `unreadCounts` (a `Map<userId, number>`) and
 * `archivedBy` (an array of user ids). Both are now columns on the participant
 * row, which is what makes "a user who archived a conversation they are not in"
 * unrepresentable. This repository therefore returns PARTICIPANTS carrying their
 * own `unreadCount` and `archivedAt`, and does not re-derive the two aggregate
 * shapes — re-assembling them here would un-port the decision the ledger made.
 * Whether the HTTP layer still emits them is a serialization question for the
 * switch, answered where the DTO is built.
 *
 * `lastMessage` IS re-assembled, and the difference is not arbitrary: it was
 * flattened into three columns purely for storage and has no other home, whereas
 * the two above were moved onto a row that is itself part of the result.
 */

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { constraintNameOf, uuidv7, type SelectedRow } from "@oxyhq/db";
import { publicColumns } from "@oxyhq/db/assert";
import type { ConversationParticipantRole, ConversationType } from "@allo/shared-types";
import type { AlloDatabase } from "../index";
import { PROTECTED_COLUMNS } from "../protectedColumns";
import { conversationParticipants, conversations } from "../schema/conversations";

/**
 * Neither table registers a protected column, so this is every column — and it
 * stays correct, rather than merely lucky, if one is ever registered.
 */
const CONVERSATION_COLUMNS = publicColumns(conversations, PROTECTED_COLUMNS);
const PARTICIPANT_COLUMNS = publicColumns(conversationParticipants, PROTECTED_COLUMNS);

/** One person's membership, carrying the two Mongo `Map`s that collapsed onto it. */
export interface ConversationParticipantRecord {
  readonly userId: string;
  readonly role: ConversationParticipantRole;
  readonly joinedAt: Date;
  readonly lastReadAt: Date | null;
  readonly unreadCount: number;
  readonly archivedAt: Date | null;
}

/** The denormalised preview, re-assembled from its three columns. */
export interface ConversationLastMessageRecord {
  readonly text: string | null;
  readonly senderId: string;
  readonly timestamp: Date;
}

export interface ConversationRecord {
  readonly id: string;
  readonly type: ConversationType;
  readonly name: string | null;
  readonly description: string | null;
  readonly avatar: string | null;
  readonly theme: string | null;
  readonly createdBy: string;
  readonly lastMessageAt: Date | null;
  readonly lastMessage: ConversationLastMessageRecord | null;
  readonly participants: readonly ConversationParticipantRecord[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type ConversationRow = SelectedRow<typeof CONVERSATION_COLUMNS>;
type ParticipantRow = SelectedRow<typeof PARTICIPANT_COLUMNS>;

function toParticipantRecord(row: ParticipantRow): ConversationParticipantRecord {
  return {
    userId: row.userId,
    role: row.role,
    joinedAt: row.joinedAt,
    lastReadAt: row.lastReadAt,
    unreadCount: row.unreadCount,
    archivedAt: row.archivedAt,
  };
}

function toConversationRecord(
  row: ConversationRow,
  participants: readonly ConversationParticipantRecord[],
): ConversationRecord {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    avatar: row.avatar,
    theme: row.theme,
    createdBy: row.createdBy,
    lastMessageAt: row.lastMessageAt,
    // Present only when the preview really identifies a message. `text` alone is
    // optional — an encrypted message stores a placeholder, and a media-only one
    // stored nothing at all.
    lastMessage:
      row.lastMessageSenderId !== null && row.lastMessageTimestamp !== null
        ? {
            text: row.lastMessageText,
            senderId: row.lastMessageSenderId,
            timestamp: row.lastMessageTimestamp,
          }
        : null,
    participants,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Participants for a whole page of conversations in ONE query.
 *
 * The alternative — a query per conversation — is the N+1 the conversation list
 * would feel first, since it is the one screen that loads fifty at a time.
 */
async function loadParticipants(
  db: AlloDatabase,
  conversationIds: readonly string[],
): Promise<Map<string, ConversationParticipantRecord[]>> {
  const byConversation = new Map<string, ConversationParticipantRecord[]>();
  if (conversationIds.length === 0) return byConversation;

  const rows = await db
    .select(PARTICIPANT_COLUMNS)
    .from(conversationParticipants)
    .where(inArray(conversationParticipants.conversationId, [...conversationIds]))
    .orderBy(asc(conversationParticipants.joinedAt), asc(conversationParticipants.id));

  for (const row of rows) {
    const existing = byConversation.get(row.conversationId);
    const record = toParticipantRecord(row);
    if (existing) existing.push(record);
    else byConversation.set(row.conversationId, [record]);
  }
  return byConversation;
}

async function hydrate(
  db: AlloDatabase,
  rows: readonly ConversationRow[],
): Promise<ConversationRecord[]> {
  const participants = await loadParticipants(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toConversationRecord(row, participants.get(row.id) ?? []));
}

export interface ListConversationsInput {
  readonly userId: string;
  readonly limit: number;
  readonly offset: number;
}

/**
 * Every conversation the user participates in and has NOT archived.
 *
 * `order by last_message_at desc nulls last` is load-bearing rather than
 * decorative. Mongo sorts a missing value LOWEST, so `{lastMessageAt: -1}` put
 * conversations that never received a message at the END; Postgres defaults
 * `desc` to NULLS FIRST, which would open the list on every empty conversation a
 * user has ever created. The port has to say `nulls last` to mean what the
 * source meant.
 *
 * Offset paging is kept as Mongo had it (`.skip`). Keyset paging would be
 * better and is a deliberate non-change: it is a contract change for the client,
 * not a porting detail.
 */
export async function listConversationsForUser(
  db: AlloDatabase,
  input: ListConversationsInput,
): Promise<ConversationRecord[]> {
  const rows = await db
    .select(CONVERSATION_COLUMNS)
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      eq(conversationParticipants.conversationId, conversations.id),
    )
    .where(
      and(
        eq(conversationParticipants.userId, input.userId),
        isNull(conversationParticipants.archivedAt),
      ),
    )
    .orderBy(
      sql`${conversations.lastMessageAt} desc nulls last`,
      desc(conversations.createdAt),
      desc(conversations.id),
    )
    .limit(input.limit)
    .offset(input.offset);

  return hydrate(db, rows);
}

/**
 * One conversation, but only for someone who is in it.
 *
 * This is the authorization primitive `routes/messages.ts` leans on too: Mongo
 * spelled it `findOne({_id, "participants.userId": userId})`, so "not found" and
 * "not yours" are deliberately the same answer and neither confirms the
 * conversation exists.
 */
export async function findConversationForParticipant(
  db: AlloDatabase,
  conversationId: string,
  userId: string,
): Promise<ConversationRecord | null> {
  const rows = await db
    .select(CONVERSATION_COLUMNS)
    .from(conversations)
    .innerJoin(
      conversationParticipants,
      eq(conversationParticipants.conversationId, conversations.id),
    )
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);

  const hydrated = await hydrate(db, rows);
  return hydrated[0] ?? null;
}

/**
 * The same question as {@link findConversationForParticipant} when the caller
 * only needs the yes/no. Six message routes check membership; five of them then
 * never touch the conversation again, and loading it plus its participants for a
 * boolean is work with no reader. Only the send path needs the full record,
 * because it emits to every participant's room.
 */
export async function isConversationParticipant(
  db: AlloDatabase,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: conversationParticipants.id })
    .from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * The existing `direct` conversation between exactly these people, if there is
 * one — the dedupe `POST /api/conversations` runs before creating another.
 *
 * Mongo asked for `$all` the ids plus `participants.2: {$exists: false}`, i.e.
 * "contains both AND has no third". Both halves are kept: `count(*) = 2` is the
 * second one, and dropping it would match a group-sized `direct` row rather than
 * trusting the count trigger to have made that impossible.
 */
export async function findDirectConversationBetween(
  db: AlloDatabase,
  userIds: readonly [string, string],
): Promise<ConversationRecord | null> {
  const matches = await db
    .select({ id: conversationParticipants.conversationId })
    .from(conversationParticipants)
    .innerJoin(conversations, eq(conversations.id, conversationParticipants.conversationId))
    .where(eq(conversations.type, "direct"))
    .groupBy(conversationParticipants.conversationId)
    .having(
      and(
        sql`count(*) = 2`,
        sql`count(*) filter (where ${conversationParticipants.userId} in (${userIds[0]}, ${userIds[1]})) = 2`,
      ),
    )
    .limit(1);

  const match = matches[0];
  if (!match) return null;

  const rows = await db
    .select(CONVERSATION_COLUMNS)
    .from(conversations)
    .where(eq(conversations.id, match.id))
    .limit(1);

  const hydrated = await hydrate(db, rows);
  return hydrated[0] ?? null;
}

export interface NewParticipant {
  readonly userId: string;
  readonly role: ConversationParticipantRole;
}

export interface CreateConversationInput {
  readonly type: ConversationType;
  readonly createdBy: string;
  readonly participants: readonly NewParticipant[];
  readonly name?: string | null;
  readonly description?: string | null;
  readonly avatar?: string | null;
}

/**
 * Create a conversation and its participants together.
 *
 * The field list is explicit and closed — a caller cannot widen it by handing
 * over a request body, which is the mass-assignment shape (`new Model(req.body)`)
 * this port is the opportunity to leave behind.
 *
 * Whether a `direct` conversation may carry a name, and whether the creator is
 * the admin, are the caller's policy and are NOT re-decided here; Mongo did not
 * decide them either, and inventing the restriction now would be a new one.
 */
export async function createConversation(
  db: AlloDatabase,
  input: CreateConversationInput,
): Promise<ConversationRecord> {
  const conversationId = uuidv7();

  return db.transaction(async (tx) => {
    await tx.insert(conversations).values({
      id: conversationId,
      type: input.type,
      name: input.name ?? null,
      description: input.description ?? null,
      avatar: input.avatar ?? null,
      createdBy: input.createdBy,
    });

    if (input.participants.length > 0) {
      await tx.insert(conversationParticipants).values(
        input.participants.map((participant) => ({
          id: uuidv7(),
          conversationId,
          userId: participant.userId,
          role: participant.role,
        })),
      );
    }

    const rows = await tx
      .select(CONVERSATION_COLUMNS)
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const participantRows = await tx
      .select(PARTICIPANT_COLUMNS)
      .from(conversationParticipants)
      .where(eq(conversationParticipants.conversationId, conversationId))
      .orderBy(asc(conversationParticipants.joinedAt), asc(conversationParticipants.id));

    const row = rows[0];
    if (!row) {
      throw new Error(`Conversation ${conversationId} vanished inside its own transaction`);
    }
    return toConversationRecord(row, participantRows.map(toParticipantRecord));
  });
}

/**
 * The four mutable presentation fields, each applied only when the caller names
 * it — `undefined` means "leave alone" and `null` means "clear", which is the
 * distinction a spread of the request body throws away.
 */
export interface ConversationDetailsPatch {
  readonly name?: string | null;
  readonly description?: string | null;
  readonly avatar?: string | null;
  readonly theme?: string | null;
}

export async function updateConversationDetails(
  db: AlloDatabase,
  conversationId: string,
  patch: ConversationDetailsPatch,
): Promise<ConversationRecord | null> {
  const values: {
    name?: string | null;
    description?: string | null;
    avatar?: string | null;
    theme?: string | null;
  } = {};
  if (patch.name !== undefined) values.name = patch.name;
  if (patch.description !== undefined) values.description = patch.description;
  if (patch.avatar !== undefined) values.avatar = patch.avatar;
  if (patch.theme !== undefined) values.theme = patch.theme;

  if (Object.keys(values).length === 0) {
    // Mongoose's `save()` on an untouched document issued no write and left
    // `updatedAt` alone. An empty PUT must not become a write here either.
    const rows = await db
      .select(CONVERSATION_COLUMNS)
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    const hydrated = await hydrate(db, rows);
    return hydrated[0] ?? null;
  }

  const rows = await db
    .update(conversations)
    .set(values)
    .where(eq(conversations.id, conversationId))
    .returning(CONVERSATION_COLUMNS);

  const hydrated = await hydrate(db, rows);
  return hydrated[0] ?? null;
}

/**
 * Add people to a conversation, converging rather than refusing.
 *
 * Mongo read the current members, filtered the request against them in memory
 * and pushed the remainder — two concurrent adds of the same person both saw an
 * absence and both pushed. `ON CONFLICT DO NOTHING` against
 * `conversation_participants_conversation_id_user_id_key` closes that: the
 * duplicate is refused by the index, not by a comparison that raced.
 */
export async function addParticipants(
  db: AlloDatabase,
  conversationId: string,
  participants: readonly NewParticipant[],
): Promise<ConversationRecord | null> {
  if (participants.length > 0) {
    await db
      .insert(conversationParticipants)
      .values(
        participants.map((participant) => ({
          id: uuidv7(),
          conversationId,
          userId: participant.userId,
          role: participant.role,
        })),
      )
      .onConflictDoNothing({
        target: [conversationParticipants.conversationId, conversationParticipants.userId],
      });
  }

  const rows = await db
    .select(CONVERSATION_COLUMNS)
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const hydrated = await hydrate(db, rows);
  return hydrated[0] ?? null;
}

/**
 * Why removal reports an outcome instead of throwing.
 *
 * "A group keeps at least two members" is now the deferred constraint trigger,
 * and the trigger is the ONLY thing that can answer it without the race the
 * route's in-memory length check had. But it is still a rule the caller has to
 * report as a 400 rather than a 500, so the one constraint that means exactly
 * that is translated here — by NAME, via `constraintNameOf`, never by matching
 * the driver's message text, which would pass for a different constraint on the
 * same statement.
 */
export type RemoveParticipantOutcome =
  | { readonly outcome: "removed" }
  | { readonly outcome: "not_a_participant" }
  | { readonly outcome: "would_leave_too_few" };

export async function removeParticipant(
  db: AlloDatabase,
  conversationId: string,
  userId: string,
): Promise<RemoveParticipantOutcome> {
  try {
    const removed = await db
      .delete(conversationParticipants)
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.userId, userId),
        ),
      )
      .returning({ id: conversationParticipants.id });

    return removed.length > 0 ? { outcome: "removed" } : { outcome: "not_a_participant" };
  } catch (error: unknown) {
    if (constraintNameOf(error) === "conversations_participant_count_check") {
      return { outcome: "would_leave_too_few" };
    }
    throw error;
  }
}

/**
 * Archive or unarchive, for one person only.
 *
 * `archivedAt` rather than a boolean because the timestamp answers "since when"
 * for free and still reads as a flag. Returns whether the caller is actually a
 * participant, which is the 404 the route needs.
 */
export async function setConversationArchived(
  db: AlloDatabase,
  conversationId: string,
  userId: string,
  archived: boolean,
): Promise<boolean> {
  const rows = await db
    .update(conversationParticipants)
    .set({ archivedAt: archived ? new Date() : null })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .returning({ id: conversationParticipants.id });
  return rows.length > 0;
}

/**
 * Mark a conversation read: both halves of what Mongo did in two places — the
 * participant's `lastReadAt` and the `unreadCounts` entry, which now live on the
 * same row and therefore cannot disagree.
 */
export async function markConversationRead(
  db: AlloDatabase,
  conversationId: string,
  userId: string,
): Promise<boolean> {
  const rows = await db
    .update(conversationParticipants)
    .set({ lastReadAt: new Date(), unreadCount: 0 })
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.userId, userId),
      ),
    )
    .returning({ id: conversationParticipants.id });
  return rows.length > 0;
}
