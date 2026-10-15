import { and, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import type { AlloDatabase } from '../index';
import { calls, callParticipants } from '../schema/calls';
import { clientInstances } from '../schema/instances';

/** Durable, leased at-least-once delivery. Native call IDs deduplicate lost provider replies. */
export async function claimCallPushes(db: AlloDatabase, now: Date) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: callParticipants.id,
        callId: calls.id,
        conversationId: calls.conversationId,
        mode: calls.mode,
        expiresAt: calls.ringExpiresAt,
        instanceId: clientInstances.id,
        accountId: clientInstances.accountId,
        provider: clientInstances.callPushProvider,
        token: clientInstances.callPushToken,
      })
      .from(callParticipants)
      .innerJoin(calls, eq(calls.id, callParticipants.callId))
      .innerJoin(clientInstances, eq(clientInstances.id, callParticipants.instanceId))
      .where(
        and(
          eq(calls.state, 'ringing'),
          gt(calls.ringExpiresAt, now),
          eq(callParticipants.state, 'ringing'),
          eq(clientInstances.status, 'active'),
          sql`${clientInstances.callPushToken} is not null`,
          isNull(callParticipants.ringPushDeliveredAt),
          or(
            isNull(callParticipants.ringPushLeaseUntil),
            lt(callParticipants.ringPushLeaseUntil, now),
          ),
        ),
      )
      .limit(32)
      .for('update', { of: callParticipants, skipLocked: true });
    const lease = new Date(now.getTime() + 20_000);
    for (const row of rows)
      await tx
        .update(callParticipants)
        .set({ ringPushLeaseUntil: lease })
        .where(eq(callParticipants.id, row.id));
    return rows.map((row) => ({ ...row, lease }));
  });
}
export async function deliveredCallPush(db: AlloDatabase, id: string, lease: Date, at: Date) {
  await db
    .update(callParticipants)
    .set({ ringPushDeliveredAt: at, ringPushLeaseUntil: null })
    .where(and(eq(callParticipants.id, id), eq(callParticipants.ringPushLeaseUntil, lease)));
}

/** A terminal hint never uses PushKit: Apple reserves VoIP pushes for new calls. */
export async function claimCallEndPushes(db: AlloDatabase, now: Date) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: callParticipants.id,
        callId: calls.id,
        instanceId: clientInstances.id,
        accountId: clientInstances.accountId,
        provider: clientInstances.callPushProvider,
        callToken: clientInstances.callPushToken,
        alertToken: clientInstances.pushToken,
      })
      .from(callParticipants)
      .innerJoin(calls, eq(calls.id, callParticipants.callId))
      .innerJoin(clientInstances, eq(clientInstances.id, callParticipants.instanceId))
      .where(
        and(
          sql`${callParticipants.ringPushDeliveredAt} is not null`,
          isNull(callParticipants.ringPushEndedAt),
          or(eq(calls.state, 'ended'), sql`${callParticipants.state} not in ('ringing', 'joined')`),
          or(
            isNull(callParticipants.ringPushLeaseUntil),
            lt(callParticipants.ringPushLeaseUntil, now),
          ),
        ),
      )
      .limit(32)
      .for('update', { of: callParticipants, skipLocked: true });
    const lease = new Date(now.getTime() + 5_000);
    for (const row of rows)
      await tx
        .update(callParticipants)
        .set({ ringPushLeaseUntil: lease })
        .where(eq(callParticipants.id, row.id));
    return rows.map((row) => ({ ...row, lease }));
  });
}
export async function deliveredCallEnd(db: AlloDatabase, id: string, lease: Date, now: Date) {
  await db
    .update(callParticipants)
    .set({ ringPushEndedAt: now })
    .where(and(eq(callParticipants.id, id), eq(callParticipants.ringPushLeaseUntil, lease)));
}
