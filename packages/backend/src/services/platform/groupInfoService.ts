/**
 * The stored GroupInfo (`docs/platform/api-v1.md`, Conversations):
 * `GET` and `PUT /v1/conversations/:id/group-info`.
 *
 * `GET` is what a device that is a member with no active leaf joins from, so
 * it is gated by the caller's account being a `joined` member and nothing
 * more — that device holds no leaf, by definition. `PUT` re-publishes for the
 * CURRENT epoch only, by a device that holds an active leaf (it is describing
 * a group state it is in); it exists for conversations whose last commit
 * predates `CommitInfo.groupInfo`, and is refused with `epoch_conflict` for
 * any other epoch so a re-publish that raced a commit cannot describe the
 * epoch before it.
 *
 * `null` from `GET` is the client's cue to wait for an elector. The server
 * never raises `group_info_missing` itself.
 */

import type { GroupInfoResponse, PutGroupInfoRequest, StoredGroupInfo } from "@allo/shared-types";
import { getDb, type AlloDatabase } from "../../db";
import { findActiveLeaf, findConversationById, findMember, lockConversation } from "../../db/platform/conversationRepository";
import { findGroupInfo, upsertGroupInfo, type GroupInfoRow } from "../../db/platform/groupInfoRepository";
import { AlloHttpError, forbidden, notFound } from "../../utils/httpErrors";
import type { Caller } from "./conversationService";

function toStoredGroupInfo(row: GroupInfoRow): StoredGroupInfo {
  return {
    epoch: row.epoch,
    signerInstanceId: row.signerInstanceId,
    data: Buffer.from(row.data).toString("base64"),
    // When THIS GroupInfo was produced: the row is replaced in place on every
    // commit, so that is its `updated_at`, not the row's first insert.
    createdAt: row.updatedAt.toISOString(),
  };
}

export async function getGroupInfo(
  caller: Caller,
  conversationId: string,
  deps: { db?: AlloDatabase } = {},
): Promise<GroupInfoResponse> {
  const db = deps.db ?? getDb();
  // A stranger learns nothing, not even that the conversation exists; an
  // account that left or was removed is told so, since re-admission is not
  // its own to arrange.
  const member = await findMember(conversationId, caller.accountId, db);
  if (!member) throw notFound("Conversation not found");
  if (member.state !== "joined") throw forbidden("This account is no longer a member of the conversation");
  const conversation = await findConversationById(conversationId, db);
  if (!conversation) throw notFound("Conversation not found");
  const row = await findGroupInfo(conversationId, db);
  // Only the current epoch's is any use to a joiner; a stale one (which the
  // same-transaction upsert should make impossible) is served as none.
  if (!row || row.epoch !== conversation.currentEpoch) return { groupInfo: null };
  return { groupInfo: toStoredGroupInfo(row) };
}

export async function putGroupInfo(
  caller: Caller,
  conversationId: string,
  request: PutGroupInfoRequest,
  deps: { db?: AlloDatabase } = {},
): Promise<GroupInfoResponse> {
  const db = deps.db ?? getDb();
  const member = await findMember(conversationId, caller.accountId, db);
  if (!member) throw notFound("Conversation not found");
  return db.transaction(async (tx) => {
    // Under the conversation's lock, so the epoch compared is the epoch the
    // row describes when the write lands.
    const conversation = await lockConversation(conversationId, tx);
    if (!conversation) throw notFound("Conversation not found");
    const leaf = await findActiveLeaf(conversationId, caller.instanceId, tx);
    if (!leaf) throw forbidden("This instance holds no active leaf in the conversation");
    if (request.epoch !== conversation.currentEpoch) {
      throw new AlloHttpError("epoch_conflict", "A GroupInfo can be re-published for the current epoch only", {
        currentEpoch: conversation.currentEpoch,
      });
    }
    await upsertGroupInfo(
      { conversationId, epoch: request.epoch, signerInstanceId: caller.instanceId, data: Buffer.from(request.data, "base64") },
      tx,
    );
    const row = await findGroupInfo(conversationId, tx);
    if (!row) throw notFound("Conversation not found"); // unreachable: written a line above under the lock
    return { groupInfo: toStoredGroupInfo(row) };
  });
}
