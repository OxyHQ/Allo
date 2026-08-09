/**
 * `moderation_events` — the inbound webhook dedupe claim, shared across tasks, and
 * the audit trail of what CrowdSource told this deployment to do.
 *
 * `@oxyhq/crowdsource-express` defaults to an IN-PROCESS store and says exactly
 * when that is not enough: two instances behind a load balancer each keep their
 * own, so a redelivery landing on the OTHER instance is not deduplicated. Allo runs
 * on ECS Fargate behind one ALB, so this is that case.
 *
 * ## The INSERT is the claim, and that is now a VALUE rather than a throw
 *
 * `id` is the CrowdSource event id and it is the primary key, so a conflict is not
 * an error condition to work around — it is the answer "somebody else has this
 * event". Under Mongo that answer arrived as a duplicate-key ERROR (`code 11000`)
 * which `moderationEventStore.ts` had to recognise by inspecting an exception and
 * separate from every other failure. `on conflict (id) do nothing … returning`
 * gives it as a value instead.
 *
 * That is the load-bearing difference, not a tidier spelling. A lost connection, a
 * failover or pool exhaustion is NOT "already processed": it has to propagate so
 * the middleware answers non-2xx and the event stays on CrowdSource's retry
 * schedule (§10.9). Swallowing it would answer 200 and retire a decision nobody
 * ever handled — and the Mongo shape made that one mis-widened `catch` away. Here
 * there is no catch to widen: the duplicate never throws, and everything that does
 * throw reaches the caller.
 *
 * A claim is released by DELETING the row, not by marking it failed — see
 * {@link releaseModerationEvent}.
 */

import { eq } from "drizzle-orm";
import { getDb, type AlloDatabaseOrTransaction } from "../index";
import { moderationEvents } from "../schema/moderation";
import { requireTransaction } from "./transactionGuard";

/**
 * Retention.
 *
 * §10.9's retry schedule ends at 24 hours, so a dedupe row only has to outlive
 * that. It is kept far longer because the row is also the audit trail of what a
 * third party told this deployment to do, and an enforcement question asked weeks
 * later is answered from here. This is the deadline `db/expiry.ts` reaps against.
 */
export const MODERATION_EVENT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * Take the claim on an event id.
 *
 * Deliberately NOT transactional, and deliberately not paired with anything: the
 * middleware claims BEFORE running the handler, so that a concurrent redelivery
 * cannot also run it. A claim that only became visible when the handler's own
 * transaction committed would deduplicate nothing during the window it exists for.
 *
 * @returns `true` when THIS call took the claim, `false` when it was already held.
 *   A thrown error is neither: it means the store could not answer, and the caller
 *   must let it propagate rather than read it as "already processed".
 */
export async function claimModerationEvent(
  eventId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = new Date();
  const claimed = await db
    .insert(moderationEvents)
    .values({
      id: eventId,
      state: "claimed",
      receivedAt: now,
      expiresAt: new Date(now.getTime() + MODERATION_EVENT_RETENTION_SECONDS * 1_000),
    })
    .onConflictDoNothing({ target: moderationEvents.id })
    .returning({ id: moderationEvents.id });

  return claimed.length === 1;
}

/**
 * Give the claim back so a redelivery can be processed.
 *
 * Called when the handler THROWS. Recording an id and never releasing it would make
 * a transient failure permanent and lose a decision silently — which is why this
 * DELETES rather than marking the row failed, and why there is no state value for
 * it to write instead.
 */
export async function releaseModerationEvent(
  eventId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<void> {
  await db.delete(moderationEvents).where(eq(moderationEvents.id, eventId));
}

/**
 * Complete the audit row for a decision-bearing event, with the CALLER's
 * transaction.
 *
 * The transaction is required for the reason `ModerationInboundService` opens one
 * at all, and it is a sharper reason than the intake path's. The middleware has
 * ALREADY claimed this event id, so the dedupe is in force; if completing the row
 * and queueing the work were two operations, a crash between them would leave an
 * event permanently deduplicated with no work queued — a decision silently lost,
 * with a row that says it arrived. Committing both together means the only outcomes
 * are "recorded and queued" or "neither", and "neither" leaves the claim to be
 * released and the event redelivered.
 *
 * Guarding only the outbox half would leave that reachable: a caller that queued
 * inside a transaction and completed this row outside it gets the same lost
 * decision, and nothing would refuse it.
 *
 * An update, never an upsert: an event id with no claimed row is one nothing
 * claimed, and inserting one here would manufacture an audit trail for a webhook
 * this deployment never accepted.
 *
 * @returns `true` when the claimed row was found and completed.
 */
export async function markModerationEventQueued(
  input: {
    eventId: string;
    type: string;
    caseId: string;
    payload: unknown;
    queuedAt?: Date;
  },
  db: AlloDatabaseOrTransaction,
): Promise<boolean> {
  const tx = requireTransaction(db, `markModerationEventQueued(${input.eventId})`);
  const updated = await tx
    .update(moderationEvents)
    .set({
      type: input.type,
      caseId: input.caseId,
      payload: input.payload,
      state: "queued",
      queuedAt: input.queuedAt ?? new Date(),
    })
    .where(eq(moderationEvents.id, input.eventId))
    .returning({ id: moderationEvents.id });

  return updated.length === 1;
}

/**
 * Record an event there is nothing to do about.
 *
 * `case.created`, `case.escalated`, `case.closed` and any type a newer CrowdSource
 * introduces. No outbox row, because no work — and therefore no transaction, this
 * being the one write of the pair that has no partner. The row is kept because "did
 * CrowdSource tell us about this case, and when" is the first question asked when a
 * report looks stuck.
 *
 * `caseId` is left ALONE when the caller has none, rather than written as NULL: an
 * ignored event that carries no case must not erase a case id an earlier write
 * recorded for the same row.
 */
export async function markModerationEventIgnored(
  input: { eventId: string; type: string; caseId?: string },
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(moderationEvents)
    .set({
      type: input.type,
      ...(input.caseId === undefined ? {} : { caseId: input.caseId }),
      state: "ignored",
    })
    .where(eq(moderationEvents.id, input.eventId))
    .returning({ id: moderationEvents.id });

  return updated.length === 1;
}
