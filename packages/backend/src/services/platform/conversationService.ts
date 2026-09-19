/**
 * Conversations (`docs/platform/api-v1.md`, Conversations).
 */

import { isUniqueViolation } from "@oxy.so/db";
import { dmKeyFor, type ConversationSummary, type CreateConversationRequest, type ResetConversationRequest } from "@allo/shared-types";
import { getDb, type AlloDatabase, type AlloDatabaseOrTransaction, type AlloTransaction } from "../../db";
import {
  findConversationByDmKey,
  findConversationById,
  findConversationByMlsGroupId,
  findMember,
  insertConversation,
  listConversationIdsForAccount,
  listConversationsByIds,
  listLeaves,
  listLeavesForConversations,
  listMembersForConversations,
  lockConversation,
  markLeafRemoved,
  replaceConversationGroup,
  setMemberState,
  upsertJoinedMember,
  upsertLeaf,
} from "../../db/platform/conversationRepository";
import { appendClientEvent, appendControlEvent } from "../../db/platform/eventRepository";
import { findGroupInfo } from "../../db/platform/groupInfoRepository";
import { getRealtime } from "../../runtime/realtime";
import { AlloHttpError, notFound, validationFailed } from "../../utils/httpErrors";
import { toConversationSummary } from "./wire";

export interface Caller {
  instanceId: string;
  accountId: string;
  appId: string;
}

async function summariesFor(
  ids: readonly string[],
  viewerInstanceId: string,
  db: AlloDatabaseOrTransaction,
): Promise<ConversationSummary[]> {
  const [rows, members, leaves] = await Promise.all([
    listConversationsByIds(ids, db),
    listMembersForConversations(ids, db),
    listLeavesForConversations(ids, db),
  ]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined)
    .map((row) =>
      toConversationSummary(
        row,
        members.filter((member) => member.conversationId === row.id),
        leaves.filter((leaf) => leaf.conversationId === row.id),
        viewerInstanceId,
      ),
    );
}

export async function listConversations(caller: Caller, deps: { db?: AlloDatabase } = {}): Promise<ConversationSummary[]> {
  const db = deps.db ?? getDb();
  const ids = await listConversationIdsForAccount(caller.accountId, db);
  return summariesFor(ids, caller.instanceId, db);
}

export async function getConversation(
  caller: Caller,
  conversationId: string,
  deps: { db?: AlloDatabase } = {},
): Promise<ConversationSummary> {
  const db = deps.db ?? getDb();
  const member = await findMember(conversationId, caller.accountId, db);
  if (!member) throw notFound("Conversation not found");
  const [summary] = await summariesFor([conversationId], caller.instanceId, db);
  if (!summary) throw notFound("Conversation not found");
  return summary;
}

export interface CreateConversationResult {
  conversation: ConversationSummary;
  created: boolean;
  /** Recipients of the initial commit's deliveries, to nudge after commit. */
  nudges: string[];
}

/**
 * Create, or converge. A DM is unique on its `dm_key`; a group on its
 * `mls_group_id`. A retry of the same create by the same instance converges on
 * the existing row; a different instance's collision on `mls_group_id` is a
 * genuine `idempotency_conflict`.
 */
export async function createConversation(
  caller: Caller,
  request: CreateConversationRequest,
  deps: { db?: AlloDatabase } = {},
): Promise<CreateConversationResult> {
  const db = deps.db ?? getDb();
  if (request.memberAccountIds.includes(caller.accountId)) {
    throw validationFailed("the creator is implied and must not be listed", { path: ["memberAccountIds"] });
  }
  const dmKey = request.kind === "dm" ? dmKeyFor(caller.appId, caller.accountId, request.memberAccountIds[0]) : null;

  const existingByGroup = await findConversationByMlsGroupId(request.mlsGroupId, db);
  if (existingByGroup) {
    if (existingByGroup.createdByInstanceId !== caller.instanceId) {
      throw new AlloHttpError("idempotency_conflict", "This mlsGroupId belongs to another conversation");
    }
    const [conversation] = await summariesFor([existingByGroup.id], caller.instanceId, db);
    return { conversation, created: false, nudges: [] };
  }

  let nudges: string[] = [];
  let createdId: string | null = null;
  try {
    createdId = await db.transaction(async (tx) => {
      const row = await insertConversation(
        {
          kind: request.kind,
          appId: caller.appId,
          dmKey,
          mlsGroupId: request.mlsGroupId,
          createdByAccountId: caller.accountId,
          createdByInstanceId: caller.instanceId,
        },
        tx,
      );
      await upsertJoinedMember({ conversationId: row.id, accountId: caller.accountId, role: "owner", addedByAccountId: null }, tx);
      for (const accountId of request.memberAccountIds) {
        await upsertJoinedMember({ conversationId: row.id, accountId, role: "member", addedByAccountId: caller.accountId }, tx);
      }
      await upsertLeaf(
        { conversationId: row.id, instanceId: caller.instanceId, accountId: caller.accountId, state: "active", addedEpoch: 0 },
        tx,
      );
      if (request.initialCommit) {
        const appended = await appendClientEvent(
          { conversationId: row.id, sender: { instanceId: caller.instanceId, accountId: caller.accountId }, request: request.initialCommit },
          tx,
        );
        nudges = appended.recipients;
      }
      return row.id;
    });
  } catch (error: unknown) {
    if (dmKey !== null && isUniqueViolation(error, "conversations_dm_key_key")) {
      const existing = await findConversationByDmKey(dmKey, db);
      if (!existing) throw error;
      const [conversation] = await summariesFor([existing.id], caller.instanceId, db);
      return { conversation, created: false, nudges: [] };
    }
    if (isUniqueViolation(error, "conversations_mls_group_id_key")) {
      throw new AlloHttpError("idempotency_conflict", "This mlsGroupId belongs to another conversation");
    }
    throw error;
  }

  const [conversation] = await summariesFor([createdId], caller.instanceId, db);
  return { conversation, created: true, nudges };
}

/**
 * REVIVE a conversation whose MLS group has lost every active leaf.
 *
 * A group can end up with none: the only device in it was revoked, or the last
 * member signed out. Nothing can ever be committed to such a group again, so
 * nobody can be added back to it — and a DM is unique on its `dm_key`, so
 * "just start a new conversation" converges on the same dead row. Two people
 * would never be able to speak again.
 *
 * **The rule, and it is the whole security of this route: the group must be
 * provably dead.** Zero leaves in state `active`. While one is alive the reset
 * is refused, so this can never eject a participant or take over a live
 * conversation — the surviving device would have to be revoked first, and only
 * its own account can do that. The caller must also be a joined member, and a
 * stranger gets `not_found` like everywhere else.
 *
 * What survives: the conversation id, its members, its `dm_key`, and its event
 * log. What does not: every message sent before the reset stays unreadable —
 * which it already was, because nobody holds the keys and neither a history
 * transfer nor a backup carries MLS state.
 */
export async function resetConversation(
  caller: Caller,
  conversationId: string,
  request: ResetConversationRequest,
  deps: { db?: AlloDatabase } = {},
): Promise<{ conversation: ConversationSummary; nudges: string[] }> {
  const db = deps.db ?? getDb();
  const member = await findMember(conversationId, caller.accountId, db);
  if (!member || member.state !== "joined") throw notFound("Conversation not found");

  const claimed = await findConversationByMlsGroupId(request.mlsGroupId, db);
  if (claimed && claimed.id !== conversationId) {
    throw new AlloHttpError("idempotency_conflict", "This mlsGroupId belongs to another conversation");
  }

  let nudges: string[] = [];
  await db.transaction(async (tx) => {
    const conversation = await lockConversation(conversationId, tx);
    if (!conversation) throw notFound("Conversation not found");
    const leaves = await listLeaves(conversationId, tx);
    /**
     * A replay of the caller's own reset. Once it lands the group is ALIVE —
     * this device's leaf is the live one — so the rule below would refuse the
     * retry that a dropped response makes normal. Matching on the exact group
     * the caller installed gives nothing away: anybody it would let through is
     * already in the conversation.
     */
    const mine = leaves.find((leaf) => leaf.instanceId === caller.instanceId);
    if (conversation.mlsGroupId === request.mlsGroupId && mine?.state === "active") return;

    const alive = leaves.filter((leaf) => leaf.state === "active");
    if (alive.length > 0 && !(await mayRekeyDirect(conversation, caller, leaves, tx))) {
      throw new AlloHttpError("idempotency_conflict", "The conversation still has an active device and cannot be reset", {
        activeLeaves: alive.length,
      });
    }
    // Idempotent: the same group posted twice resets once.
    if (conversation.mlsGroupId !== request.mlsGroupId) {
      await replaceConversationGroup(conversationId, request.mlsGroupId, tx);
    }
    for (const leaf of leaves) {
      if (leaf.state !== "removed") await markLeafRemoved(conversationId, leaf.instanceId, null, tx);
    }
    await upsertLeaf(
      { conversationId, instanceId: caller.instanceId, accountId: caller.accountId, state: "active", addedEpoch: 0 },
      tx,
    );
    if (request.initialCommit) {
      const appended = await appendClientEvent(
        { conversationId, sender: { instanceId: caller.instanceId, accountId: caller.accountId }, request: request.initialCommit },
        tx,
      );
      nudges = appended.recipients;
    }
  });

  const [conversation] = await summariesFor([conversationId], caller.instanceId, db);
  return { conversation, nudges };
}

/**
 * May this caller re-key a DM it cannot otherwise get into?
 *
 * The plain rule is that a group with a live device is never reset, because a
 * reset would let one member rebuild the membership without the others. That
 * rule leaves one person stuck for ever, and it is the case people actually
 * hit: a DM made before GroupInfos existed, whose other device has not been
 * opened since. Nothing can add this device — only a member inside a group may
 * commit an Add — and nothing can let it in by itself, because there is no
 * GroupInfo to join from. "Wait for the other person to open their app" is not
 * an answer a messenger may give.
 *
 * So a DM, and only a DM, may be re-keyed by an account that was IN the group
 * and FELL OUT of it, and only while no GroupInfo exists to join from. Five
 * conditions, and each is doing work:
 *
 * - **A DM has exactly one other member**, so there is no membership to
 *   manipulate: dropping the only other person leaves the caller alone in a
 *   conversation with nobody, which is not an attack, it is pointlessness.
 * - **The caller is already a joined member**, so it is not a stranger.
 * - **No leaf of the caller's ACCOUNT is active**, so the account can read
 *   NOTHING of this conversation today: the re-key hands it no access it did
 *   not have, and the history stays exactly as unreadable to it as it was.
 * - **Some leaf of the caller's account is `removed`** — it HAD a seat and
 *   lost it, to a revoked device or wiped site data. This is the condition
 *   that separates the two cases that otherwise look identical: an account
 *   that has NEVER held a leaf is a newcomer, and a newcomer is what the
 *   elector rule is for. Without it, the first device of somebody who had not
 *   installed Allo yet would re-key the conversation out from under the person
 *   who started it, discarding the messages held for them.
 * - **No GroupInfo exists**, so the honest way in — RFC 9420's external commit
 *   — is genuinely unavailable rather than merely inconvenient.
 *
 * A GROUP is never re-keyed this way, and does not need to be: every commit
 * made since GroupInfos existed publishes one, so the gap closes itself.
 */
async function mayRekeyDirect(
  conversation: { id: string; kind: string },
  caller: Caller,
  leaves: readonly { instanceId: string; accountId: string; state: string }[],
  tx: AlloTransaction,
): Promise<boolean> {
  if (conversation.kind !== "dm") return false;
  const ours = leaves.filter((leaf) => leaf.accountId === caller.accountId);
  if (ours.some((leaf) => leaf.state === "active")) return false;
  if (!ours.some((leaf) => leaf.state === "removed")) return false;
  return (await findGroupInfo(conversation.id, tx)) === null;
}

/**
 * Server-side leave: the account's member row becomes `left`, its leaves
 * `removed` pending a commit, and a `member_left` control event tells the
 * others. Deletes nothing.
 */
export async function leaveConversation(caller: Caller, conversationId: string, deps: { db?: AlloDatabase } = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const member = await findMember(conversationId, caller.accountId, db);
  if (!member) throw notFound("Conversation not found");
  if (member.state !== "joined") return;

  const recipients = await db.transaction(async (tx) => {
    const conversation = await lockConversation(conversationId, tx);
    if (!conversation) throw notFound("Conversation not found");
    const leaves = await listLeaves(conversationId, tx);
    const mine = leaves.filter((leaf) => leaf.accountId === caller.accountId && leaf.state !== "removed");
    for (const leaf of mine) await markLeafRemoved(conversationId, leaf.instanceId, null, tx);
    await setMemberState(conversationId, caller.accountId, "left", tx);
    const appended = await appendControlEvent(
      { conversationId, control: { t: "member_left", accountId: caller.accountId }, excludeInstanceIds: mine.map((l) => l.instanceId) },
      tx,
    );
    return appended.recipients;
  });
  getRealtime().nudge(recipients, { conversationId });
}

export { findConversationById };
