import { getDb, type AlloDatabase } from '../db';
import {
  claimCallPushes,
  deliveredCallPush,
  claimCallEndPushes,
  deliveredCallEnd,
} from '../db/platform/callPushRepository';
import { clearCallPushToken } from '../db/platform/instanceRepository';
import { sendPush } from '../services/push/dispatch';

export async function runCallPushTick(
  deps: { db?: AlloDatabase; now?: () => Date; push?: typeof sendPush } = {},
): Promise<void> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();
  const ended = await claimCallEndPushes(db, now);
  await Promise.all(
    ended.map(async (row) => {
      const token = row.provider === 'apns' ? row.alertToken : row.callToken;
      if (!token || !row.provider) {
        await deliveredCallEnd(db, row.id, row.lease, now);
        return;
      }
      const result = await (deps.push ?? sendPush)(
        [{ platform: row.provider === 'apns' ? 'ios' : 'android', token }],
        {
          title: 'Allo',
          body: '',
          background: true,
          data: {
            type: 'allo.call.end',
            callId: row.callId,
            instanceId: row.instanceId,
            accountId: row.accountId,
          },
        },
      );
      if (!result.hasTransientFailure) await deliveredCallEnd(db, row.id, row.lease, now);
    }),
  );
  const pending = await claimCallPushes(db, now);
  await Promise.all(
    pending.map(async (row) => {
      if (!row.token || !row.provider || !row.expiresAt) return;
      const result = await (deps.push ?? sendPush)(
        [{ platform: row.provider === 'apns' ? 'ios' : 'android', token: row.token }],
        {
          title: 'Allo',
          body: 'Incoming call',
          call: { expiresAt: row.expiresAt.toISOString() },
          data: {
            type: 'allo.call',
            callId: row.callId,
            conversationId: row.conversationId,
            accountId: row.accountId,
            instanceId: row.instanceId,
            mode: row.mode,
            expiresAt: row.expiresAt.toISOString(),
          },
        },
      );
      if (result.rejected.includes(row.token))
        await clearCallPushToken(row.instanceId, db, row.token);
      if (!result.hasTransientFailure) await deliveredCallPush(db, row.id, row.lease, now);
    }),
  );
}
