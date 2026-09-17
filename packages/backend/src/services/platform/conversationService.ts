/**
 * Conversations (`docs/platform/api-v1.md`, Conversations).
 */

import { isUniqueViolation } from "@oxy.so/db";
import { dmKeyFor, type ConversationSummary, type CreateConversationRequest } from "@allo/shared-types";
import { getDb, type AlloDatabase, type AlloDatabaseOrTransaction } from "../../db";
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
  setMemberState,
  upsertJoinedMember,
  upsertLeaf,
} from "../../db/platform/conversationRepository";
import { appendClientEvent, appendControlEvent } from "../../db/platform/eventRepository";
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
