/**
 * `instance_deliveries` — written with the event, read as the sync stream,
 * claimed by the delivery worker.
 *
 * The claim is Mention's outbox shape (`EngagementOutboxService`): the id
 * subselect carries `FOR UPDATE SKIP LOCKED`, so N workers never hand each
 * other the same row and never wait on one another. A row stays `pending`
 * while leased — the closed status set has no `processing` — and a lease that
 * expired is due again, so a worker that died mid-batch strands nothing.
 */

import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getDb, type AlloDatabaseOrTransaction } from "../index";
import { requireTransaction } from "../moderation/transactionGuard";
import { instanceDeliveries, type DeliveryStatus } from "../schema/deliveries";
import { conversationEvents } from "../schema/events";
import { EVENT_COLUMNS, type EventReadRow } from "./eventRepository";

/** How long a delivery stays in the stream unacked before `db/expiry.ts` drops it. */
export const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export type DeliveryRow = typeof instanceDeliveries.$inferSelect;

export async function insertDeliveries(
  input: { eventId: string; conversationId: string; instanceIds: readonly string[] },
  db: AlloDatabaseOrTransaction,
): Promise<void> {
  const tx = requireTransaction(db, `insertDeliveries(${input.eventId})`);
  if (input.instanceIds.length === 0) return;
  const expiresAt = new Date(Date.now() + DELIVERY_RETENTION_MS);
  await tx
    .insert(instanceDeliveries)
    .values(
      input.instanceIds.map((instanceId) => ({
        eventId: input.eventId,
        conversationId: input.conversationId,
        instanceId,
        expiresAt,
      })),
    )
    .onConflictDoNothing({ target: [instanceDeliveries.eventId, instanceDeliveries.instanceId] });
}

export interface StreamEntry {
  deliveryId: number;
  conversationId: string;
  event: EventReadRow;
}

/** The instance's stream after `afterId`, `limit + 1` rows so the caller can say `hasMore`. */
export async function readSyncStream(
  instanceId: string,
  afterId: number,
  limit: number,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<{ entries: StreamEntry[]; hasMore: boolean }> {
  const rows = await db
    .select({ deliveryId: instanceDeliveries.id, ...EVENT_COLUMNS })
    .from(instanceDeliveries)
    .innerJoin(conversationEvents, eq(conversationEvents.id, instanceDeliveries.eventId))
    .where(and(eq(instanceDeliveries.instanceId, instanceId), gt(instanceDeliveries.id, afterId)))
    .orderBy(asc(instanceDeliveries.id))
    .limit(limit + 1);
  const entries = rows.slice(0, limit).map(({ deliveryId, ...event }) => ({
    deliveryId,
    conversationId: event.conversationId,
    event,
  }));
  return { entries, hasMore: rows.length > limit };
}

/** Everything up to and including `upToId` for this instance becomes `acked`. Returns how many changed. */
export async function ackDeliveries(
  instanceId: string,
  upToId: number,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .update(instanceDeliveries)
    .set({ status: "acked", ackedAt: new Date(), leaseOwner: null, leaseUntil: null })
    .where(
      and(
        eq(instanceDeliveries.instanceId, instanceId),
        lte(instanceDeliveries.id, upToId),
        sql`${instanceDeliveries.status} <> 'acked'`,
      ),
    )
    .returning({ id: instanceDeliveries.id });
  return rows.length;
}

/**
 * Claim up to `limit` due deliveries under a lease. Due: `pending`, available,
 * and not leased by a live worker. Ordered by id so the oldest goes first.
 */
export async function claimDueDeliveries(
  options: { leaseOwner: string; leaseMs: number; limit: number; now?: Date },
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<DeliveryRow[]> {
  const now = options.now ?? new Date();
  const due = db
    .select({ id: instanceDeliveries.id })
    .from(instanceDeliveries)
    .where(
      and(
        eq(instanceDeliveries.status, "pending"),
        lte(instanceDeliveries.availableAt, now),
        or(isNull(instanceDeliveries.leaseUntil), lte(instanceDeliveries.leaseUntil, now)),
      ),
    )
    .orderBy(asc(instanceDeliveries.id))
    .limit(options.limit)
    .for("update", { skipLocked: true });

  return db
    .update(instanceDeliveries)
    .set({
      leaseOwner: options.leaseOwner,
      leaseUntil: new Date(now.getTime() + options.leaseMs),
      attempts: sql`${instanceDeliveries.attempts} + 1`,
      lastError: null,
    })
    .where(inArray(instanceDeliveries.id, due))
    .returning();
}

/** Owner-checked transition out of `pending`. True iff this worker still held the lease. */
export async function settleDelivery(
  id: number,
  leaseOwner: string,
  status: Extract<DeliveryStatus, "notified" | "dead">,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(instanceDeliveries)
    .set({
      status,
      notifiedAt: status === "notified" ? new Date() : undefined,
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(instanceDeliveries.id, id),
        eq(instanceDeliveries.status, "pending"),
        eq(instanceDeliveries.leaseOwner, leaseOwner),
        gt(instanceDeliveries.leaseUntil, new Date()),
      ),
    )
    .returning({ id: instanceDeliveries.id });
  return rows.length === 1;
}

/** Owner-checked retry: release the lease and schedule the next attempt. */
export async function deferDelivery(
  id: number,
  leaseOwner: string,
  input: { availableAt: Date; error: string },
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const rows = await db
    .update(instanceDeliveries)
    .set({
      availableAt: input.availableAt,
      lastError: input.error.slice(0, 2_000),
      leaseOwner: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(instanceDeliveries.id, id),
        eq(instanceDeliveries.status, "pending"),
        eq(instanceDeliveries.leaseOwner, leaseOwner),
      ),
    )
    .returning({ id: instanceDeliveries.id });
  return rows.length === 1;
}

export async function findDeliveryById(
  id: number,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<DeliveryRow | null> {
  const [row] = await db.select().from(instanceDeliveries).where(eq(instanceDeliveries.id, id)).limit(1);
  return row ?? null;
}

export async function listDeliveriesForEvent(
  eventId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<DeliveryRow[]> {
  return db
    .select()
    .from(instanceDeliveries)
    .where(eq(instanceDeliveries.eventId, eventId))
    .orderBy(asc(instanceDeliveries.id));
}
