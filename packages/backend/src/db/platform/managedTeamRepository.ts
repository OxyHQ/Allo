import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { managedTeams } from '../schema';
import { getDb, type AlloDatabaseOrTransaction } from '..';
import { listMembers, findConversationById } from './conversationRepository';
import type { TeamSnapshot } from '@oxy.so/allo-contracts';
export const teamCapabilityHash = (capability: string) =>
  createHash('sha256').update(capability).digest('hex');
export async function findManagedTeam(
  conversationId: string,
  db: AlloDatabaseOrTransaction = getDb(),
) {
  const [row] = await db.select().from(managedTeams).where(eq(managedTeams.id, conversationId));
  return row;
}
export async function findTeamByHash(hash: string, db: AlloDatabaseOrTransaction = getDb()) {
  const [row] = await db
    .select()
    .from(managedTeams)
    .where(eq(managedTeams.readCapabilityHash, hash));
  return row;
}
export async function teamSnapshot(
  hash: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<TeamSnapshot | null> {
  const team = await findTeamByHash(hash, db);
  if (!team) return null;
  const conversation = await findConversationById(team.id, db);
  if (!conversation) return null;
  const members = await listMembers(team.id, db);
  return {
    conversationId: team.id,
    sourceReference: team.sourceReference,
    ownerAccountId: conversation.createdByAccountId,
    epoch: conversation.currentEpoch,
    memberAccountIds: members
      .filter((m) => m.state === 'joined')
      .map((m) => m.accountId)
      .sort(),
    operationId: team.operationId,
    frozen: team.frozen,
  };
}
export async function setTeamOperation(
  conversationId: string,
  operationId: string,
  targetAccountIds: string[],
  db: AlloDatabaseOrTransaction,
) {
  await db
    .update(managedTeams)
    .set({ operationId, targetAccountIds, frozen: true })
    .where(eq(managedTeams.id, conversationId));
}
export async function releaseTeam(
  conversationId: string,
  operationId: string,
  db: AlloDatabaseOrTransaction,
) {
  await db
    .update(managedTeams)
    .set({ frozen: false })
    .where(and(eq(managedTeams.id, conversationId), eq(managedTeams.operationId, operationId)));
}
