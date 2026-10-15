/** Metadata-only references: never inspect ciphertext to derive authorization. */
import { and, arrayContains, eq, gt, or } from 'drizzle-orm';
import type { AlloDatabaseOrTransaction } from '../index';
import { conversationEvents } from '../schema/events';
import { conversationMembers } from '../schema/conversations';
import { statuses, statusKeys } from '../schema/statuses';

export const MAX_BLOB_ACCESS_REFERENCES = 100;
export async function blobReferences(
  blobId: string,
  accountId: string,
  instanceId: string,
  db: AlloDatabaseOrTransaction,
) {
  const events = await db
    .select({
      id: conversationEvents.id,
      conversationId: conversationEvents.conversationId,
      senderAccountId: conversationEvents.senderAccountId,
    })
    .from(conversationEvents)
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, conversationEvents.conversationId),
        eq(conversationMembers.accountId, accountId),
      ),
    )
    .where(arrayContains(conversationEvents.blobIds, [blobId]))
    .limit(MAX_BLOB_ACCESS_REFERENCES + 1);
  const statusRows = await db
    .select({ id: statuses.id, authorAccountId: statuses.authorAccountId })
    .from(statuses)
    .leftJoin(
      statusKeys,
      and(eq(statusKeys.statusId, statuses.id), eq(statusKeys.instanceId, instanceId)),
    )
    .where(
      and(
        arrayContains(statuses.blobIds, [blobId]),
        eq(statuses.state, 'live'),
        gt(statuses.expiresAt, new Date()),
        or(eq(statuses.authorAccountId, accountId), eq(statusKeys.instanceId, instanceId)),
      ),
    )
    .limit(MAX_BLOB_ACCESS_REFERENCES + 1);
  return { events, statuses: statusRows };
}
