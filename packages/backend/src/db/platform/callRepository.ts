/**
 * `calls`, `call_participants` — SQL only.
 *
 * The one query worth reading twice is {@link claimExpiredRings}: it is an
 * UPDATE that both finds and settles, so two tasks sweeping at the same second
 * cannot both decide a call was missed and both write a log for it.
 */

import { and, eq, inArray, lte, sql } from "drizzle-orm";
import { uuidv7 } from "@oxy.so/db";
import type { CallEndReason, CallMode } from "@allo/shared-types";
import { requireTransaction } from "../moderation/transactionGuard";
import type { AlloDatabaseOrTransaction } from "../index";
import { callParticipants, calls, type CallParticipantState } from "../schema/calls";

export type CallRow = typeof calls.$inferSelect;
export type CallParticipantRow = typeof callParticipants.$inferSelect;

export interface InsertCallInput {
  id: string;
  conversationId: string;
  initiatorAccountId: string;
  initiatorInstanceId: string;
  mode: CallMode;
  relayed: boolean;
  group: boolean;
  idempotencyKey: string;
  ringExpiresAt: Date;
  expiresAt: Date;
}

export async function insertCall(input: InsertCallInput, db: AlloDatabaseOrTransaction): Promise<CallRow> {
  requireTransaction(db, "insertCall");
  const [row] = await db.insert(calls).values(input).returning();
  return row;
}

export interface InsertParticipantInput {
  callId: string;
  accountId: string;
  instanceId: string;
  expiresAt: Date;
}

export async function insertParticipants(rows: readonly InsertParticipantInput[], db: AlloDatabaseOrTransaction): Promise<void> {
  requireTransaction(db, "insertParticipants");
  if (rows.length === 0) return;
  await db
    .insert(callParticipants)
    .values(rows.map((row) => ({ id: uuidv7(), ...row })))
    .onConflictDoNothing({ target: [callParticipants.callId, callParticipants.instanceId] });
}

export async function findCallById(id: string, db: AlloDatabaseOrTransaction): Promise<CallRow | null> {
  const [row] = await db.select().from(calls).where(eq(calls.id, id)).limit(1);
  return row ?? null;
}

export async function findCallByIdempotencyKey(
  initiatorInstanceId: string,
  idempotencyKey: string,
  db: AlloDatabaseOrTransaction,
): Promise<CallRow | null> {
  const [row] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.initiatorInstanceId, initiatorInstanceId), eq(calls.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row ?? null;
}

export async function listParticipants(callId: string, db: AlloDatabaseOrTransaction): Promise<CallParticipantRow[]> {
  return db.select().from(callParticipants).where(eq(callParticipants.callId, callId));
}

export async function findParticipant(
  callId: string,
  instanceId: string,
  db: AlloDatabaseOrTransaction,
): Promise<CallParticipantRow | null> {
  const [row] = await db
    .select()
    .from(callParticipants)
    .where(and(eq(callParticipants.callId, callId), eq(callParticipants.instanceId, instanceId)))
    .limit(1);
  return row ?? null;
}

export async function setParticipantState(
  callId: string,
  instanceId: string,
  state: CallParticipantState,
  at: Date,
  db: AlloDatabaseOrTransaction,
): Promise<void> {
  await db
    .update(callParticipants)
    .set({
      state,
      ...(state === "joined" ? { joinedAt: at } : {}),
      ...(state === "left" || state === "declined" || state === "missed" ? { leftAt: at } : {}),
    })
    .where(and(eq(callParticipants.callId, callId), eq(callParticipants.instanceId, instanceId)));
}

/**
 * Participants still ringing become `state`. What stops a losing device's ring.
 *
 * `onlyAccountId` is how a group call differs from a 1:1: when somebody
 * answers, THEIR other phones stop ringing and everybody else's keep going.
 * Without it the first person to pick up would silence the rest of the group.
 */
export async function settleRingingParticipants(
  callId: string,
  state: CallParticipantState,
  at: Date,
  db: AlloDatabaseOrTransaction,
  scope: { exceptInstanceId?: string; onlyAccountId?: string } = {},
): Promise<void> {
  await db
    .update(callParticipants)
    .set({ state, leftAt: at })
    .where(
      and(
        eq(callParticipants.callId, callId),
        eq(callParticipants.state, "ringing"),
        scope.exceptInstanceId === undefined ? undefined : sql`${callParticipants.instanceId} <> ${scope.exceptInstanceId}`,
        scope.onlyAccountId === undefined ? undefined : eq(callParticipants.accountId, scope.onlyAccountId),
      ),
    );
}

/**
 * `ringing` → `active`, once, returning the row only for the call that made
 * the transition. A second device answering a hundred milliseconds later gets
 * `null` and is told who won.
 */
export async function claimAnswer(callId: string, at: Date, db: AlloDatabaseOrTransaction): Promise<CallRow | null> {
  const [row] = await db
    .update(calls)
    .set({ state: "active", answeredAt: at, ringExpiresAt: null })
    .where(and(eq(calls.id, callId), eq(calls.state, "ringing")))
    .returning();
  return row ?? null;
}

/** → `ended`, once. Null when it had already ended, so the caller does not write a second log. */
export async function claimEnd(
  callId: string,
  reason: CallEndReason,
  at: Date,
  db: AlloDatabaseOrTransaction,
): Promise<CallRow | null> {
  const [row] = await db
    .update(calls)
    .set({ state: "ended", endedAt: at, endReason: reason, ringExpiresAt: null, expiresAt: at })
    .where(and(eq(calls.id, callId), sql`${calls.state} <> 'ended'`))
    .returning();
  return row ?? null;
}

/**
 * Every ring whose deadline has passed, settled in the same statement that
 * finds it.
 *
 * Two tasks sweep on the same second; the UPDATE's `WHERE state = 'ringing'`
 * is what makes exactly one of them own each call, and only the owner emits
 * and writes. Finding first and updating second would have both of them ring
 * off the same call.
 */
export async function claimExpiredRings(now: Date, limit: number, db: AlloDatabaseOrTransaction): Promise<CallRow[]> {
  const due = db
    .select({ id: calls.id })
    .from(calls)
    .where(and(eq(calls.state, "ringing"), lte(calls.ringExpiresAt, now)))
    .limit(limit);
  return db
    .update(calls)
    .set({ state: "ended", endedAt: now, endReason: "missed", ringExpiresAt: null, expiresAt: now })
    .where(inArray(calls.id, due))
    .returning();
}
