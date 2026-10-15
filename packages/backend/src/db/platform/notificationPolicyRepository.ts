/** Read notification provenance in batches; never read message payloads. */
import { desc, inArray } from 'drizzle-orm';
import { getDb } from '../index';
import { conversationEvents } from '../schema/events';
import { statuses } from '../schema/statuses';
import { conversations } from '../schema/conversations';
import { calls } from '../schema/calls';
import { transcriptParticipants } from './transcriptPolicyRepository';

export async function notificationProvenance(input: {
  conversationIds: string[];
  statusIds: string[];
  callIds: string[];
}) {
  return getDb().transaction(
    async (tx) => {
      const callRows = input.callIds.length
        ? await tx
            .select({
              id: calls.id,
              conversationId: calls.conversationId,
              initiatorAccountId: calls.initiatorAccountId,
            })
            .from(calls)
            .where(inArray(calls.id, input.callIds))
        : [];
      const conversationIds = [
        ...new Set([...input.conversationIds, ...callRows.map((row) => row.conversationId)]),
      ];
      const conversationRows = conversationIds.length
        ? await tx
            .select({ id: conversations.id, createdByAccountId: conversations.createdByAccountId })
            .from(conversations)
            .where(inArray(conversations.id, conversationIds))
        : [];
      const members = await transcriptParticipants(conversationIds, tx);
      const latestEvents = input.conversationIds.length
        ? await tx
            .selectDistinctOn([conversationEvents.conversationId], {
              conversationId: conversationEvents.conversationId,
              senderAccountId: conversationEvents.senderAccountId,
            })
            .from(conversationEvents)
            .where(inArray(conversationEvents.conversationId, input.conversationIds))
            .orderBy(conversationEvents.conversationId, desc(conversationEvents.seq))
        : [];
      const statusRows = input.statusIds.length
        ? await tx
            .select({ id: statuses.id, authorAccountId: statuses.authorAccountId })
            .from(statuses)
            .where(inArray(statuses.id, input.statusIds))
        : [];
      return { members, conversationRows, latestEvents, statuses: statusRows, calls: callRows };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
