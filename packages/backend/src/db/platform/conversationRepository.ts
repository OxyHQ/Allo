/**
 * `conversations`, `conversation_members`, `conversation_leaves`.
 *
 * The event log's writes (`eventRepository.ts`) lock the conversation row
 * first; the functions here that change membership or leaves are called from
 * inside that lock and take the transaction handle explicitly.
 */

import { and, asc, eq, inArray, isNull, notExists, or, sql } from "drizzle-orm";
import { uuidv7 } from "@oxy.so/db";
import { getDb, type AlloDatabaseOrTransaction, type AlloTransaction } from "../index";
import { requireTransaction } from "../moderation/transactionGuard";
import {
  conversationLeaves,
  conversationMembers,
  conversations,
  type ConversationKind,
  type LeafState,
  type MemberRole,
  type MemberState,
} from "../schema/conversations";
import { clientInstances } from "../schema/instances";

export type ConversationRow = typeof conversations.$inferSelect;
export type MemberRow = typeof conversationMembers.$inferSelect;
export type LeafRow = typeof conversationLeaves.$inferSelect;

export interface InsertConversationInput {
  kind: ConversationKind;
  appId: string;
  dmKey: string | null;
  mlsGroupId: string;
  createdByAccountId: string;
  createdByInstanceId: string;
}

export async function insertConversation(
  input: InsertConversationInput,
  db: AlloDatabaseOrTransaction,
): Promise<ConversationRow> {
  const tx = requireTransaction(db, "insertConversation");
  const [row] = await tx
    .insert(conversations)
    .values({ id: uuidv7(), ...input })
    .returning();
  return row;
}

export async function findConversationById(
  id: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<ConversationRow | null> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
  return row ?? null;
}

export async function findConversationByDmKey(
  dmKey: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<ConversationRow | null> {
  const [row] = await db.select().from(conversations).where(eq(conversations.dmKey, dmKey)).limit(1);
  return row ?? null;
}

export async function findConversationByMlsGroupId(
  mlsGroupId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<ConversationRow | null> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.mlsGroupId, mlsGroupId))
    .limit(1);
  return row ?? null;
}

/**
 * `SELECT … FOR UPDATE` on the conversation: the serialisation point for its
 * event log. Everything that assigns a `seq` or moves the epoch holds this.
 */
export async function lockConversation(id: string, tx: AlloTransaction): Promise<ConversationRow | null> {
  const [row] = await tx.select().from(conversations).where(eq(conversations.id, id)).limit(1).for("update");
  return row ?? null;
}

export async function updateConversationCounters(
  id: string,
  values: { currentEpoch: number; lastSeq: number },
  tx: AlloTransaction,
): Promise<void> {
  await tx
    .update(conversations)
    .set({ currentEpoch: values.currentEpoch, lastSeq: values.lastSeq, updatedAt: new Date() })
    .where(eq(conversations.id, id));
}

// --- members -----------------------------------------------------------------

export interface UpsertMemberInput {
  conversationId: string;
  accountId: string;
  role: MemberRole;
  addedByAccountId: string | null;
}

/** Insert as `joined`, or re-join an account whose row exists in any state. */
export async function upsertJoinedMember(input: UpsertMemberInput, db: AlloDatabaseOrTransaction): Promise<void> {
  const tx = requireTransaction(db, "upsertJoinedMember");
  const now = new Date();
  await tx
    .insert(conversationMembers)
    .values({
      id: uuidv7(),
      conversationId: input.conversationId,
      accountId: input.accountId,
      role: input.role,
      state: "joined",
      joinedAt: now,
      addedByAccountId: input.addedByAccountId,
    })
    .onConflictDoUpdate({
      target: [conversationMembers.conversationId, conversationMembers.accountId],
      set: { state: "joined", joinedAt: now, leftAt: null, addedByAccountId: input.addedByAccountId, updatedAt: now },
      /** A `joined` row is left alone: its `joined_at` is history. */
      setWhere: sql`${conversationMembers.state} <> 'joined'`,
    });
}

export async function setMemberState(
  conversationId: string,
  accountId: string,
  state: Exclude<MemberState, "joined">,
  db: AlloDatabaseOrTransaction,
): Promise<void> {
  const tx = requireTransaction(db, "setMemberState");
  const now = new Date();
  await tx
    .update(conversationMembers)
    .set({ state, leftAt: now, updatedAt: now })
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.accountId, accountId),
        eq(conversationMembers.state, "joined"),
      ),
    );
}

export async function listMembers(
  conversationId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<MemberRow[]> {
  return db
    .select()
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversationId))
    .orderBy(asc(conversationMembers.joinedAt), asc(conversationMembers.id));
}

export async function findMember(
  conversationId: string,
  accountId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<MemberRow | null> {
  const [row] = await db
    .select()
    .from(conversationMembers)
    .where(and(eq(conversationMembers.conversationId, conversationId), eq(conversationMembers.accountId, accountId)))
    .limit(1);
  return row ?? null;
}

/** Ids of every conversation the account is a `joined` member of, newest first. */
export async function listConversationIdsForAccount(
  accountId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ id: conversations.id })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(and(eq(conversationMembers.accountId, accountId), eq(conversationMembers.state, "joined")))
    .orderBy(sql`${conversations.updatedAt} desc`, asc(conversations.id));
  return rows.map((row) => row.id);
}

/** Other accounts that share at least one conversation with `accountId` (both `joined`). Presence's audience. */
export async function listAccountsSharingConversations(
  accountId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const mine = db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.accountId, accountId), eq(conversationMembers.state, "joined")));
  const rows = await db
    .selectDistinct({ accountId: conversationMembers.accountId })
    .from(conversationMembers)
    .where(
      and(
        inArray(conversationMembers.conversationId, mine),
        eq(conversationMembers.state, "joined"),
        sql`${conversationMembers.accountId} <> ${accountId}`,
      ),
    );
  return rows.map((row) => row.accountId);
}

/**
 * Which of `candidates` share at least one conversation with `accountId`.
 *
 * The same rule as {@link listAccountsSharingConversations}, asked the other
 * way round: a presence watch set names the accounts a screen is showing, and
 * what matters is which of THOSE may be answered for — not the whole
 * co-membership graph, which for a busy account is most of the address book.
 */
export async function listSharedAccountsAmong(
  accountId: string,
  candidates: readonly string[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const mine = db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(and(eq(conversationMembers.accountId, accountId), eq(conversationMembers.state, "joined")));
  const rows = await db
    .selectDistinct({ accountId: conversationMembers.accountId })
    .from(conversationMembers)
    .where(
      and(
        inArray(conversationMembers.conversationId, mine),
        eq(conversationMembers.state, "joined"),
        inArray(conversationMembers.accountId, [...candidates]),
        sql`${conversationMembers.accountId} <> ${accountId}`,
      ),
    );
  return new Set(rows.map((row) => row.accountId));
}

// --- leaves ------------------------------------------------------------------

export interface UpsertLeafInput {
  conversationId: string;
  instanceId: string;
  accountId: string;
  state: LeafState;
  addedEpoch: number;
}

/** Insert, or re-add a leaf whose row exists (a removed instance added back). */
export async function upsertLeaf(input: UpsertLeafInput, db: AlloDatabaseOrTransaction): Promise<void> {
  const tx = requireTransaction(db, "upsertLeaf");
  const now = new Date();
  await tx
    .insert(conversationLeaves)
    .values({ id: uuidv7(), ...input, removedEpoch: null })
    .onConflictDoUpdate({
      target: [conversationLeaves.conversationId, conversationLeaves.instanceId],
      set: { state: input.state, accountId: input.accountId, addedEpoch: input.addedEpoch, removedEpoch: null, updatedAt: now },
    });
}

export async function markLeafRemoved(
  conversationId: string,
  instanceId: string,
  removedEpoch: number | null,
  db: AlloDatabaseOrTransaction,
): Promise<void> {
  const tx = requireTransaction(db, "markLeafRemoved");
  await tx
    .update(conversationLeaves)
    .set({ state: "removed", removedEpoch, updatedAt: new Date() })
    .where(and(eq(conversationLeaves.conversationId, conversationId), eq(conversationLeaves.instanceId, instanceId)));
}

export async function listLeaves(
  conversationId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<LeafRow[]> {
  return db
    .select()
    .from(conversationLeaves)
    .where(eq(conversationLeaves.conversationId, conversationId))
    .orderBy(asc(conversationLeaves.createdAt), asc(conversationLeaves.id));
}

export async function listLeavesForConversations(
  conversationIds: readonly string[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<LeafRow[]> {
  if (conversationIds.length === 0) return [];
  return db
    .select()
    .from(conversationLeaves)
    .where(inArray(conversationLeaves.conversationId, [...conversationIds]))
    .orderBy(asc(conversationLeaves.createdAt), asc(conversationLeaves.id));
}

export async function listMembersForConversations(
  conversationIds: readonly string[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<MemberRow[]> {
  if (conversationIds.length === 0) return [];
  return db
    .select()
    .from(conversationMembers)
    .where(inArray(conversationMembers.conversationId, [...conversationIds]))
    .orderBy(asc(conversationMembers.joinedAt), asc(conversationMembers.id));
}

export async function listConversationsByIds(
  ids: readonly string[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<ConversationRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(conversations).where(inArray(conversations.id, [...ids]));
}

/** Conversations in which the instance holds an ACTIVE leaf, or a server-side removed one no commit has confirmed. */
export async function listConversationIdsWithLiveLeaf(
  instanceId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<string[]> {
  const rows = await db
    .select({ conversationId: conversationLeaves.conversationId })
    .from(conversationLeaves)
    .where(
      and(
        eq(conversationLeaves.instanceId, instanceId),
        or(
          eq(conversationLeaves.state, "active"),
          and(eq(conversationLeaves.state, "removed"), isNull(conversationLeaves.removedEpoch)),
        ),
      ),
    );
  return rows.map((row) => row.conversationId);
}

/**
 * Conversations the account is a `joined` member of WITHOUT an active leaf,
 * each with the instances that do hold one there. The audience to nudge when
 * the account's first instance becomes active: until then the conversation's
 * electors had nobody of the account's to add, and without the nudge they
 * learn of the new leaf only on their sync interval. A conversation with no
 * active leaf at all has nobody to tell and is left out.
 */
export async function listConversationsAwaitingAccountLeaf(
  accountId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<{ conversationId: string; activeLeafInstanceIds: string[] }[]> {
  const awaiting = await db
    .select({ conversationId: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.accountId, accountId),
        eq(conversationMembers.state, "joined"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(conversationLeaves)
            .where(
              and(
                eq(conversationLeaves.conversationId, conversationMembers.conversationId),
                eq(conversationLeaves.accountId, accountId),
                eq(conversationLeaves.state, "active"),
              ),
            ),
        ),
      ),
    );
  if (awaiting.length === 0) return [];
  const leaves = await db
    .select({ conversationId: conversationLeaves.conversationId, instanceId: conversationLeaves.instanceId })
    .from(conversationLeaves)
    .where(
      and(
        inArray(
          conversationLeaves.conversationId,
          awaiting.map((row) => row.conversationId),
        ),
        eq(conversationLeaves.state, "active"),
      ),
    )
    .orderBy(asc(conversationLeaves.createdAt), asc(conversationLeaves.id));
  const byConversation = new Map<string, string[]>();
  for (const leaf of leaves) {
    const ids = byConversation.get(leaf.conversationId) ?? [];
    ids.push(leaf.instanceId);
    byConversation.set(leaf.conversationId, ids);
  }
  return [...byConversation].map(([conversationId, activeLeafInstanceIds]) => ({ conversationId, activeLeafInstanceIds }));
}

export async function findActiveLeaf(
  conversationId: string,
  instanceId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<LeafRow | null> {
  const [row] = await db
    .select()
    .from(conversationLeaves)
    .where(
      and(
        eq(conversationLeaves.conversationId, conversationId),
        eq(conversationLeaves.instanceId, instanceId),
        eq(conversationLeaves.state, "active"),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** Instances that may be added: they exist, are `active`, and belong to the account the commit says. */
export async function findAddableInstances(
  ids: readonly string[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<{ id: string; accountId: string }[]> {
  if (ids.length === 0) return [];
  return db
    .select({ id: clientInstances.id, accountId: clientInstances.accountId })
    .from(clientInstances)
    .where(and(inArray(clientInstances.id, [...ids]), eq(clientInstances.status, "active")));
}
