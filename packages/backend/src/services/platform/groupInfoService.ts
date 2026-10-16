import { transcriptParticipants } from '../../db/platform/transcriptPolicyRepository';
import {
  conversationParticipants,
  requireMessageAccess,
  requireUnchangedParticipants,
  transcriptDecisions,
} from './messagingPolicy';
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

import type { GroupInfoResponse, PutGroupInfoRequest, StoredGroupInfo } from '@allo/shared-types';
import { getDb, type AlloDatabase } from '../../db';
import {
  findActiveLeaf,
  findConversationById,
  findMember,
  lockConversation,
} from '../../db/platform/conversationRepository';
import {
  findGroupInfo,
  upsertGroupInfo,
  type GroupInfoRow,
} from '../../db/platform/groupInfoRepository';
import { AlloHttpError, forbidden, notFound } from '../../utils/httpErrors';
import type { Caller } from './conversationService';

function toStoredGroupInfo(row: GroupInfoRow): StoredGroupInfo {
  return {
    epoch: row.epoch,
    signerInstanceId: row.signerInstanceId,
    data: Buffer.from(row.data).toString('base64'),
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
  const { groupInfo, evidence } = await db.transaction(
    async (tx) => {
      const member = await findMember(conversationId, caller.accountId, tx);
      if (!member) throw notFound('Conversation not found');
      if (member.state !== 'joined')
        throw forbidden('This account is no longer a member of the conversation');
      const conversation = await findConversationById(conversationId, tx);
      if (!conversation) throw notFound('Conversation not found');
      const row = await findGroupInfo(conversationId, tx);
      return {
        groupInfo: row && row.epoch === conversation.currentEpoch ? toStoredGroupInfo(row) : null,
        evidence: await transcriptParticipants([conversationId], tx),
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  const decision = await transcriptDecisions(caller, evidence);
  if (!decision.get(conversationId)?.allowed)
    throw forbidden('This conversation is not available.');
  return { groupInfo };
}

export async function putGroupInfo(
  caller: Caller,
  conversationId: string,
  request: PutGroupInfoRequest,
  deps: { db?: AlloDatabase } = {},
): Promise<GroupInfoResponse> {
  const db = deps.db ?? getDb();
  const participants =
    (await conversationParticipants([conversationId], db)).get(conversationId) ?? [];
  await requireMessageAccess(caller, conversationId, participants);
  const member = await findMember(conversationId, caller.accountId, db);
  if (!member) throw notFound('Conversation not found');
  return db.transaction(async (tx) => {
    // Under the conversation's lock, so the epoch compared is the epoch the
    // row describes when the write lands.
    const conversation = await lockConversation(conversationId, tx);
    if (!conversation) throw notFound('Conversation not found');
    await requireUnchangedParticipants(conversationId, participants, tx);
    const leaf = await findActiveLeaf(conversationId, caller.instanceId, tx);
    if (!leaf) throw forbidden('This instance holds no active leaf in the conversation');
    if (request.epoch !== conversation.currentEpoch) {
      throw new AlloHttpError(
        'epoch_conflict',
        'A GroupInfo can be re-published for the current epoch only',
        {
          currentEpoch: conversation.currentEpoch,
        },
      );
    }
    await upsertGroupInfo(
      {
        conversationId,
        epoch: request.epoch,
        signerInstanceId: caller.instanceId,
        data: Buffer.from(request.data, 'base64'),
      },
      tx,
    );
    const row = await findGroupInfo(conversationId, tx);
    if (!row) throw notFound('Conversation not found'); // unreachable: written a line above under the lock
    return { groupInfo: toStoredGroupInfo(row) };
  });
}
