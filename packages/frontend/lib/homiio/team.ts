import type { TeamSnapshot } from '@oxy.so/allo-contracts';
import type { AlloClient } from '@allo/core';
import { isAlloNotFound } from '../allo/errors';
import type { HomiioTeamClient, BeginTeamOperation } from '@oxy.so/homiio-sdk';
/** Every retry resumes the source's durable intent. Only the creator's device touches MLS keys. */
export async function completeHomiioTeam(
  client: AlloClient,
  source: HomiioTeamClient,
  caseId: string,
  input: BeginTeamOperation,
) {
  for (let recovery = 0; recovery < 2; recovery++) {
    const { operation, capability, teamReference } = await source.begin(caseId, input);
    const access = { operationId: operation.id, operationCapability: capability, teamReference };
    let snapshot: TeamSnapshot;
    try {
      snapshot = await client.conversations.prepareTeam(access);
    } catch (error) {
      if (!isAlloNotFound(error)) throw error;
      await client.conversations.createGroupOnce(operation.id, operation.targetAccountIds, access);
      snapshot = await client.conversations.prepareTeam(access);
    }
    if (!operation.finalized) {
      await client.sync.now();
      if (!client.conversations.get(snapshot.conversationId)?.joined)
        throw new Error('This device is still joining the team. Try again shortly.');
      for (const accountId of snapshot.memberAccountIds)
        if (!operation.targetAccountIds.includes(accountId))
          await client.conversations.removeMember(snapshot.conversationId, accountId);
      for (const accountId of operation.targetAccountIds)
        if (!snapshot.memberAccountIds.includes(accountId))
          await client.conversations.addMember(snapshot.conversationId, accountId);
      await client.conversations.confirmMembers(
        snapshot.conversationId,
        operation.targetAccountIds,
      );
      await source.finalize(operation.id);
    }
    const finished = await client.conversations.finishTeam(access);
    // Finishing an interrupted earlier operation must not silently swallow the requested edit.
    if (
      input.action !== 'open' &&
      (operation.action !== input.action ||
        (input.action === 'add'
          ? !operation.targetAccountIds.includes(input.oxyUserId!)
          : operation.targetAccountIds.includes(input.oxyUserId!)))
    )
      continue;
    return finished.conversationId;
  }
  throw new Error('The previous change was recovered. Try your change again.');
}
