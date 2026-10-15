/** Live Oxy authority over metadata only. No message bytes or cached policy decisions. */
import type { Request } from 'express';
import {
  MESSAGE_ACCESS_MAX_RESOURCES,
  MESSAGE_ACCESS_MAX_PARTICIPANT_SLOTS,
  MESSAGE_ACCESS_MAX_PARTICIPANTS,
  MESSAGE_ACCESS_MAX_INPUT_BYTES,
  type SafetyDecision,
} from '@oxy.so/contracts';
import { oxy } from '../../oxy';
import { AlloHttpError, forbidden, unauthorized } from '../../utils/httpErrors';
import { getDb, type AlloDatabaseOrTransaction } from '../../db';
import { listMembersForConversations } from '../../db/platform/conversationRepository';

export interface MessagingRequester {
  accountId: string;
  accessToken: string;
}
export interface MessagingResource {
  resourceId: string;
  participantAccountIds: string[];
}
export interface DeliveryResource extends MessagingResource {
  senderAccountId: string;
}

/** Called only after canonical auth; preserve the original proof, never mint an actor from an ID. */
export function originalBearer(req: Pick<Request, 'get'>): string {
  const value = req.get('Authorization');
  if (!value?.startsWith('Bearer ') || value.length <= 7) throw unauthorized();
  return value.slice(7);
}

export function uniqueParticipants(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Bounded SQL hydration for a page; membership is authoritative in Allo, identity in Oxy. */
export async function conversationParticipants(
  ids: readonly string[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<Map<string, string[]>> {
  const result = new Map(ids.map((id) => [id, [] as string[]]));
  for (const member of await listMembersForConversations(ids, db)) {
    if (member.state === 'joined') result.get(member.conversationId)?.push(member.accountId);
  }
  for (const [id, members] of result) result.set(id, uniqueParticipants(members));
  return result;
}

/** Counts both resources and participant slots; never one request per member. */
function batches<T extends MessagingResource>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let slots = 0;
  for (const item of items) {
    if (
      current.length &&
      (current.length === MESSAGE_ACCESS_MAX_RESOURCES ||
        slots + item.participantAccountIds.length > MESSAGE_ACCESS_MAX_PARTICIPANT_SLOTS ||
        Buffer.byteLength(JSON.stringify({ items: [...current, item] })) >
          MESSAGE_ACCESS_MAX_INPUT_BYTES)
    ) {
      out.push(current);
      current = [];
      slots = 0;
    }
    current.push(item);
    slots += item.participantAccountIds.length;
  }
  if (current.length) out.push(current);
  return out;
}

function policyFailure(error: unknown): never {
  if (error instanceof AlloHttpError) throw error;
  const status =
    typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
  if (status === 401) throw unauthorized();
  if (status === 403) throw forbidden('Messaging is not available for this account.');
  throw new AlloHttpError('unavailable', 'Messaging authorization is temporarily unavailable.');
}

async function decisions<T extends MessagingResource>(
  items: readonly T[],
  request: (batch: T[]) => Promise<{ items: { resourceId: string; decision: SafetyDecision }[] }>,
): Promise<Map<string, SafetyDecision>> {
  const result = new Map<string, SafetyDecision>();
  try {
    const bounded: T[] = [];
    for (const item of items) {
      if (item.participantAccountIds.length > MESSAGE_ACCESS_MAX_PARTICIPANTS)
        result.set(item.resourceId, { allowed: false, reason: 'unavailable', policyVersion: '2' });
      else bounded.push(item);
    }
    for (const batch of batches(bounded)) {
      const response = await request(batch);
      const wanted = new Set(batch.map((item) => item.resourceId));
      if (response.items.length !== wanted.size) throw new Error('Incomplete policy response');
      for (const item of response.items) {
        if (!wanted.delete(item.resourceId)) throw new Error('Unexpected policy response');
        result.set(item.resourceId, item.decision);
      }
    }
    return result;
  } catch (error) {
    return policyFailure(error);
  }
}

export function messageDecisions(
  requester: MessagingRequester,
  items: readonly MessagingResource[],
) {
  if (!requester.accessToken) throw unauthorized();
  return decisions(items, (batch) =>
    oxy.safety.messageAccessBatch({ items: batch }, { accessToken: requester.accessToken }),
  );
}

/** Background consumers use persisted participants/sender, never a human impersonation token. */
export function deliveryDecisions(items: readonly DeliveryResource[]) {
  return decisions(items, (batch) => oxy.safety.deliveryAccessBatch({ items: batch }));
}

export async function requireMessageAccess(
  requester: MessagingRequester,
  resourceId: string,
  participants: readonly string[],
): Promise<void> {
  const participantAccountIds = uniqueParticipants(participants);
  const result = await messageDecisions(requester, [{ resourceId, participantAccountIds }]);
  if (!result.get(resourceId)?.allowed)
    throw forbidden('Messaging is not available for these participants.');
}

/** Verify the checked membership under the same lock that serializes MLS changes. */
export async function requireUnchangedParticipants(
  conversationId: string,
  expected: readonly string[],
  tx: AlloDatabaseOrTransaction,
): Promise<void> {
  const actual = (await conversationParticipants([conversationId], tx)).get(conversationId) ?? [];
  if (JSON.stringify(actual) !== JSON.stringify(uniqueParticipants(expected))) {
    throw new AlloHttpError(
      'epoch_conflict',
      'Conversation membership changed; synchronize and retry.',
    );
  }
}

/** Oversized evidence is unavailable, never truncated into an allow decision. */
export async function transcriptDecisions(
  requester: MessagingRequester,
  evidence: ReadonlyMap<string, string[]>,
) {
  const allowedSize: MessagingResource[] = [];
  const result = new Map<string, SafetyDecision>();
  for (const [resourceId, participants] of evidence) {
    const participantAccountIds = uniqueParticipants([requester.accountId, ...participants]);
    if (participantAccountIds.length > MESSAGE_ACCESS_MAX_PARTICIPANTS)
      result.set(resourceId, { allowed: false, reason: 'unavailable', policyVersion: '2' });
    else allowedSize.push({ resourceId, participantAccountIds });
  }
  for (const [id, decision] of await messageDecisions(requester, allowedSize))
    result.set(id, decision);
  return result;
}
