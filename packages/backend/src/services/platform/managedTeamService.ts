import { HomiioTeamClient, type TeamOperation } from '@homiio/sdk';
import { getDb } from '../../db';
import { lockConversation } from '../../db/platform/conversationRepository';
import {
  findTeamByHash,
  releaseTeam,
  setTeamOperation,
  teamCapabilityHash,
  teamSnapshot,
} from '../../db/platform/managedTeamRepository';
import { AlloHttpError, forbidden, notFound, validationFailed } from '../../utils/httpErrors';
import type { Caller } from './conversationService';

export interface ManagedTeamAuthorization {
  operation: TeamOperation;
  capabilityHash: string;
}
export async function authorizeTeamOperation(
  caller: Caller,
  operationId: string,
  operationCapability: string,
  teamCapability: string,
): Promise<ManagedTeamAuthorization> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(teamCapability) || !operationCapability)
    throw validationFailed('Team capability is required');
  const operation = await new HomiioTeamClient().read(operationId, operationCapability);
  const capabilityHash = teamCapabilityHash(teamCapability);
  if (
    operation.ownerAccountId !== caller.accountId ||
    operation.teamReferenceHash !== capabilityHash
  )
    throw forbidden('Only the Homiio case creator can manage this group');
  return { operation, capabilityHash };
}
export async function prepareTeam(caller: Caller, auth: ManagedTeamAuthorization) {
  return getDb().transaction(async (tx) => {
    const team = await findTeamByHash(auth.capabilityHash, tx);
    if (!team) throw notFound('Team chat not found');
    const conversation = await lockConversation(team.id, tx);
    if (
      conversation?.createdByAccountId !== caller.accountId ||
      team.sourceReference !== auth.operation.caseId
    )
      throw forbidden('Team owner mismatch');
    // Re-read after the lock: a competing operation may have committed while we waited.
    const current = (await findTeamByHash(auth.capabilityHash, tx))!;
    if (current.operationId === auth.operation.id) return teamSnapshot(auth.capabilityHash, tx);
    if (current.frozen || auth.operation.finalized)
      throw new AlloHttpError('idempotency_conflict', 'Another team operation must finish first');
    await setTeamOperation(team.id, auth.operation.id, auth.operation.targetAccountIds, tx);
    return teamSnapshot(auth.capabilityHash, tx);
  });
}
export async function finishTeam(caller: Caller, auth: ManagedTeamAuthorization) {
  if (!auth.operation.finalized)
    throw new AlloHttpError('unavailable', 'Homiio has not finalized this operation');
  return getDb().transaction(async (tx) => {
    const team = await findTeamByHash(auth.capabilityHash, tx);
    if (!team) throw notFound('Team chat not found');
    const conversation = await lockConversation(team.id, tx);
    const snapshot = await teamSnapshot(auth.capabilityHash, tx);
    if (
      conversation?.createdByAccountId !== caller.accountId ||
      !snapshot ||
      team.sourceReference !== auth.operation.caseId
    )
      throw forbidden('Team owner mismatch');
    if (
      snapshot.operationId !== auth.operation.id ||
      JSON.stringify(snapshot.memberAccountIds) !==
        JSON.stringify([...auth.operation.targetAccountIds].sort())
    )
      throw new AlloHttpError(
        'idempotency_conflict',
        'Team membership does not match the finalized operation',
      );
    await releaseTeam(team.id, auth.operation.id, tx);
    return teamSnapshot(auth.capabilityHash, tx);
  });
}
