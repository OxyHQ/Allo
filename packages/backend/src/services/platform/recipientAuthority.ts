/** Live proof for background recipients, separate from the conversation decision. */
import { MESSAGE_ACCESS_MAX_INPUT_BYTES, MESSAGE_ACCESS_MAX_RESOURCES } from '@oxy.so/contracts';
import { findInstancesByIds } from '../../db/platform/instanceRepository';
import { oxy } from '../../oxy';
import { uniqueParticipants } from './messagingPolicy';

export interface MessagingRecipient {
  requestId: string;
  accessToken: string;
  accountId: string;
  instanceId: string;
}

export async function liveMessagingRecipients(recipients: readonly MessagingRecipient[]) {
  const fresh = new Map(
    (await findInstancesByIds(uniqueParticipants(recipients.map((item) => item.instanceId)))).map(
      (instance) => [instance.id, instance],
    ),
  );
  const allowed = new Map<string, typeof fresh extends Map<string, infer T> ? T : never>();
  let batch: MessagingRecipient[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const expected = new Map(batch.map((item) => [item.requestId, item]));
    const response = await oxy.safety.messagingSessions({
      items: batch.map(({ requestId, accessToken }) => ({ requestId, accessToken })),
    });
    if (response.items.length !== expected.size) throw new Error('Incomplete recipient authority');
    for (const decision of response.items) {
      const recipient = expected.get(decision.requestId);
      if (!recipient) throw new Error('Unexpected recipient authority');
      expected.delete(decision.requestId);
      const instance = fresh.get(recipient.instanceId);
      if (
        decision.allowed &&
        instance &&
        instance.status !== 'revoked' &&
        instance.accountId === recipient.accountId &&
        decision.accountId === recipient.accountId
      ) {
        allowed.set(recipient.requestId, instance);
      }
    }
    batch = [];
  };
  for (const item of recipients) {
    const proof = { requestId: item.requestId, accessToken: item.accessToken };
    if (Buffer.byteLength(JSON.stringify({ items: [proof] })) > MESSAGE_ACCESS_MAX_INPUT_BYTES)
      continue;
    if (
      batch.length &&
      (batch.length === MESSAGE_ACCESS_MAX_RESOURCES ||
        Buffer.byteLength(
          JSON.stringify({
            items: [
              ...batch.map(({ requestId, accessToken }) => ({ requestId, accessToken })),
              proof,
            ],
          }),
        ) > MESSAGE_ACCESS_MAX_INPUT_BYTES)
    )
      await flush();
    batch.push(item);
  }
  await flush();
  return allowed;
}
