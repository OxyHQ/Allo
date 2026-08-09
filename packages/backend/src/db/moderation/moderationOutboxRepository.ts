/**
 * `moderation_outbox` — the durable promise that moderation work will happen.
 *
 * The at-least-once contract is unchanged from Mongo: an expired lease is
 * reclaimable and a worker can die mid-delivery, so every handler MUST make its
 * downstream effect idempotent using the event id.
 *
 * ## The claim is `FOR UPDATE SKIP LOCKED`, not a `findOneAndUpdate`
 *
 * Mongo claimed with an atomic `findOneAndUpdate` over a disjunctive filter.
 * Postgres has a better primitive for exactly this shape: the `select … order by
 * created_at limit 1 for update skip locked` lives INSIDE the `update`, so N
 * dispatchers draining the queue never hand each other the same row and never block
 * on one another either — `skip locked` steps over a row another task is already
 * claiming instead of waiting for it. Allo runs on ECS Fargate behind one ALB and
 * every task starts a dispatcher, so that is the normal case rather than an edge
 * one.
 *
 * `lease_until` is nullable and `NULL <= now` is NULL, so a row that has never been
 * leased is excluded from the reclaim branch by the comparison itself — matching
 * Mongo, where a missing field did not match `{$lte: now}` either.
 *
 * ## The Mongo `timestamps: false` hazard has no counterpart here, and that is the point
 *
 * The Mongo enqueue carried a long comment about writing `createdAt`/`updatedAt`
 * explicitly under `timestamps: false`, because Mongoose otherwise named
 * `updatedAt` in two operators of one update document and the server rejected the
 * WHOLE write — which, inside the intake transaction, took the `Report` with it.
 * The fix it settled on was not interchangeable with the obvious one: letting
 * Mongoose own the timestamps also cleared the server error but left a
 * `$set: { updatedAt }` on the update, turning a repeated enqueue into a real write
 * that contends with the dispatcher's live lease on that same row.
 *
 * `on conflict (id) do nothing` writes nothing at all — no tuple version, no
 * timestamp, no lock — so a repeat is a genuine no-op for a STRUCTURAL reason
 * rather than by matching a spelling. `onConflictDoUpdate` reintroduces exactly the
 * bug the Mongo flag existed to fix, and measurably so: drizzle applies the
 * column's `$onUpdate` to a conflict branch's `set`, so "write the same data back"
 * is not even a quiet write — it moves `updated_at` AND the row's `xmin`. Both are
 * asserted in `__tests__/db/moderation.realdb.test.ts`.
 *
 * ## The payload was one embedded document and is now four columns
 *
 * `db/schema/moderation.ts` flattened `ModerationOutboxPayload` into
 * `payload_report_id`, `payload_event_id`, `payload_case_id` and a `payload_decision`
 * that stays `jsonb` because the decision document is a loose third-party contract.
 * This module is the only place that translation happens, in {@link toEvent} and in
 * the enqueue, so the workers keep consuming the one object shape they always did.
 */

import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";
import { getDb, type AlloDatabaseOrTransaction } from "../index";
import {
  moderationOutbox,
  type ModerationOutboxKind,
  type ModerationOutboxStatus,
} from "../schema/moderation";
import { requireTransaction } from "./transactionGuard";

/**
 * Retention ceiling, so a stalled dispatcher cannot turn the outbox into an
 * unbounded table. Ninety days because a moderation case can legitimately sit open
 * for weeks and a `dead_letter` event is evidence somebody still has to look at.
 *
 * This is the deadline `db/expiry.ts` reaps against, and that registry states
 * outright what reaping this table costs: a `pending` row destroyed here is
 * moderation work nobody will ever deliver. Operational alerting on outbox age has
 * to fire long before this, and is not the sweep's job.
 */
export const MODERATION_OUTBOX_RETENTION_SECONDS = 90 * 24 * 60 * 60;

/**
 * Bound on a stored dispatch error.
 *
 * The Mongoose schema declared none and `ModerationOutboxService` sliced at this
 * length before every write, which is a guard that holds for exactly one caller.
 * It lives here now so it holds for all of them — the message comes from a third
 * party and nothing else bounds it. It can carry no reported material because Allo
 * never puts any into a request.
 */
const MAX_LAST_ERROR_LENGTH = 2_000;

/** The lease a dispatcher takes when it claims, and the floor any caller can ask for. */
const DEFAULT_LEASE_MS = 60_000;
const MIN_LEASE_MS = 1_000;

/**
 * The job payload, keyed by `kind`.
 *
 * A flat optional shape rather than a discriminated union, matching what the
 * workers read: each already knows its own `kind` from the row it claimed, and a
 * union would force a narrowing step at every call site that adds nothing.
 */
export interface ModerationOutboxPayload {
  /** `report.submit` — the local `reports` id. */
  reportId?: string;
  /** `decision.apply` — the inbound webhook event id. */
  eventId?: string;
  /** The CrowdSource case a decision belongs to. */
  caseId?: string;
  /**
   * The decision exactly as CrowdSource published it, whole and opaque.
   *
   * Validated against the contract when it is READ, never when it is stored, so an
   * event is never lost to a schema this deployment has not caught up with.
   */
  decision?: unknown;
}

/** One claimed event, in the shape the dispatcher and both workers consume. */
export interface ModerationOutboxEvent {
  id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  expiresAt: Date;
  createdAt: Date;
}

type OutboxRow = typeof moderationOutbox.$inferSelect;

/**
 * Absent values come back as `undefined`, never `null`.
 *
 * A field Mongo left ABSENT is `NULL` in Postgres, and every consumer of
 * `ModerationOutboxEvent` was written against `undefined` — including
 * `applyDecisionOutboxEvent`, whose first statement is `if (caseId === undefined)`.
 * A `null` reaching that check passes it and the event proceeds with no case.
 * The normalization therefore happens once, here, rather than at each reader.
 *
 * A decision stored as JSON `null` is indistinguishable from an absent one. Mongo's
 * `Mixed` had the same ambiguity and no caller depends on the difference: a
 * `decision.apply` event with no decision fails contract parsing either way.
 */
function toEvent(row: OutboxRow): ModerationOutboxEvent {
  return {
    id: row.id,
    kind: row.kind,
    payload: {
      ...(row.payloadReportId === null ? {} : { reportId: row.payloadReportId }),
      ...(row.payloadEventId === null ? {} : { eventId: row.payloadEventId }),
      ...(row.payloadCaseId === null ? {} : { caseId: row.payloadCaseId }),
      ...(row.payloadDecision === null ? {} : { decision: row.payloadDecision }),
    },
    attempts: row.attempts,
    availableAt: row.availableAt,
    ...(row.leaseOwner === null ? {} : { leaseOwner: row.leaseOwner }),
    ...(row.leaseUntil === null ? {} : { leaseUntil: row.leaseUntil }),
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
  };
}

/**
 * Write the event with the CALLER's transaction.
 *
 * The transaction is required, not optional — this is the whole point of the table:
 * the domain write and this row commit together or not at all. See
 * `transactionGuard.ts` for why the TYPE alone cannot express that, and what a
 * caller passing `getDb()` would otherwise get away with. This function
 * deliberately does NOT default its `db` parameter, because the default is the
 * mistake.
 *
 * It is also the ONLY writer of this table — every other function here claims or
 * releases an EXISTING row and none of them inserts — so no second queue can drift
 * out of sync with the outbox: the row IS the job.
 *
 * @returns The event id, so a caller can record what it queued.
 */
export async function enqueueModerationOutboxEvent(
  input: {
    eventId: string;
    kind: ModerationOutboxKind;
    payload: ModerationOutboxPayload;
  },
  db: AlloDatabaseOrTransaction,
): Promise<string> {
  const tx = requireTransaction(db, `enqueueModerationOutboxEvent(${input.eventId})`);
  const now = new Date();

  await tx
    .insert(moderationOutbox)
    .values({
      id: input.eventId,
      kind: input.kind,
      payloadReportId: input.payload.reportId,
      payloadEventId: input.payload.eventId,
      payloadCaseId: input.payload.caseId,
      payloadDecision: input.payload.decision,
      status: "pending",
      attempts: 0,
      availableAt: now,
      expiresAt: new Date(now.getTime() + MODERATION_OUTBOX_RETENTION_SECONDS * 1_000),
    })
    /**
     * NEVER `onConflictDoUpdate`. A repeat has to be a genuine no-op, and a repeat
     * is ordinary — a transaction retry, two concurrent duplicate submissions, a
     * reconciliation re-deriving this deterministic id — running while a dispatcher
     * holds a lease on this very row.
     */
    .onConflictDoNothing({ target: moderationOutbox.id });

  return input.eventId;
}

/**
 * Atomically claim one due event.
 *
 * An expired `processing` lease is reclaimable, so a dead task cannot strand
 * moderation work forever. `skip locked` is what lets several dispatchers drain the
 * queue concurrently without handing each other the same row.
 */
export async function claimModerationOutboxEvent(
  options: {
    leaseOwner: string;
    eventId?: string;
    now?: Date;
    leaseMs?: number;
  },
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<ModerationOutboxEvent | null> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(MIN_LEASE_MS, options.leaseMs ?? DEFAULT_LEASE_MS);

  const due = and(
    options.eventId ? eq(moderationOutbox.id, options.eventId) : undefined,
    or(
      and(eq(moderationOutbox.status, "pending"), lte(moderationOutbox.availableAt, now)),
      and(eq(moderationOutbox.status, "processing"), lte(moderationOutbox.leaseUntil, now)),
    ),
  );

  const claimed = await db
    .update(moderationOutbox)
    .set({
      status: "processing",
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + leaseMs),
      attempts: sql`${moderationOutbox.attempts} + 1`,
      lastError: null,
    })
    /**
     * Both references name the SAME table, so the subquery's own range entry
     * shadows the outer one inside it — which is exactly what is wanted here, and
     * is why the row the subquery locks is the row the update writes.
     */
    .where(
      sql`${moderationOutbox.id} = (
        select ${moderationOutbox.id} from ${moderationOutbox}
        where ${due}
        order by ${asc(moderationOutbox.createdAt)}
        limit 1
        for update skip locked
      )`,
    )
    .returning();

  return claimed[0] ? toEvent(claimed[0]) : null;
}

/**
 * Only the lease this dispatcher currently owns matches.
 *
 * Every terminal transition carries it, so a dispatcher whose lease expired and was
 * reclaimed by another task cannot complete, renew or release work that is no
 * longer its own — which is what stops two tasks writing contradictory outcomes for
 * one row.
 */
function ownedLease(eventId: string, leaseOwner: string, now: Date) {
  return and(
    eq(moderationOutbox.id, eventId),
    eq(moderationOutbox.status, "processing"),
    eq(moderationOutbox.leaseOwner, leaseOwner),
    gt(moderationOutbox.leaseUntil, now),
  );
}

/** Complete only the lease this dispatcher currently owns. */
export async function completeModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const completed = await db
    .update(moderationOutbox)
    .set({
      status: "processed",
      processedAt: now,
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: moderationOutbox.id });
  return completed.length === 1;
}

/** Extend only a live lease still owned by this dispatcher. */
export async function renewModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const renewed = await db
    .update(moderationOutbox)
    .set({ leaseUntil: new Date(now.getTime() + Math.max(MIN_LEASE_MS, leaseMs)) })
    .where(ownedLease(eventId, leaseOwner, now))
    .returning({ id: moderationOutbox.id });
  return renewed.length === 1;
}

/**
 * Release a failed claim, with backoff — or stop.
 *
 * `deadLettered` and `availableAt` are the CALLER's decisions: only the service
 * knows whether the error was retryable, how many attempts have been spent and what
 * its backoff curve is. This writes them, and matches the owned lease so a
 * dispatcher that already lost the row cannot overwrite the outcome its successor
 * wrote.
 */
export async function releaseModerationOutboxEvent(
  options: {
    eventId: string;
    leaseOwner: string;
    deadLettered: boolean;
    availableAt: Date;
    error: string;
    now?: Date;
  },
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const now = options.now ?? new Date();
  const released = await db
    .update(moderationOutbox)
    .set({
      status: options.deadLettered ? "dead_letter" : "pending",
      availableAt: options.availableAt,
      lastError: options.error.slice(0, MAX_LAST_ERROR_LENGTH),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(ownedLease(options.eventId, options.leaseOwner, now))
    .returning({ id: moderationOutbox.id });
  return released.length === 1;
}
