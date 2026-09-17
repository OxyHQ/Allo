/**
 * `instance_deliveries` — the outbox AND the per-instance sync stream.
 *
 * One row per (event, recipient instance), written in the same transaction as
 * the event. It serves two readers:
 *
 * - `GET /v1/sync` walks an instance's rows ordered by `id`; the cursor a
 *   client holds is base64url of that integer. `POST /v1/sync/ack` marks
 *   `id <= cursor` acked.
 * - The delivery worker claims `pending` rows with a lease and nudges or
 *   pushes the recipient.
 *
 * ## The one integer key in this schema, and why
 *
 * `id` is a `bigserial`. CONVENTIONS.md says ids are text and application
 * supplied, and names exactly one exception: a dense-ordered sync cursor. The
 * cursor has to be totally ordered and monotonic for one instance, and cheap
 * to compare in `WHERE id > $cursor` — a uuid v7 is neither (not monotonic
 * within a millisecond) and a text comparison of one is not an index range
 * scan on the integer the client meant. A sequence gives exactly that, at the
 * cost of an id that is guessable, which does not matter: every read is scoped
 * to the calling instance.
 *
 * `expires_at` is set at insert to 30 days out and swept by `db/expiry.ts`.
 * A delivery not acked in 30 days is dropped from the STREAM; the event itself
 * stays in `conversation_events` and is reachable through `GET …/events`.
 */

import { sql } from "drizzle-orm";
import { bigserial, check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, timestamptz } from "@oxy.so/db";
import { checkOneOf } from "./columns";
import { conversationEvents } from "./events";
import { clientInstances } from "./instances";

export const DELIVERY_STATUSES = ["pending", "notified", "acked", "dead"] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const instanceDeliveries = pgTable(
  "instance_deliveries",
  {
    id: bigserial({ mode: "number" }).primaryKey(),
    eventId: text()
      .notNull()
      .references(() => conversationEvents.id, { onDelete: "cascade" }),
    conversationId: text().notNull(),
    instanceId: text()
      .notNull()
      .references(() => clientInstances.id, { onDelete: "cascade" }),
    status: text({ enum: DELIVERY_STATUSES }).notNull().default("pending"),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull().defaultNow(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    notifiedAt: timestamptz(),
    ackedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("instance_deliveries_event_id_instance_id_key").on(t.eventId, t.instanceId),
    /** The sync stream: `where instance_id = ? and id > ? order by id`. */
    index("instance_deliveries_instance_id_id_idx").on(t.instanceId, t.id),
    /** Due work for the worker. */
    index("instance_deliveries_status_available_at_id_idx").on(t.status, t.availableAt, t.id),
    /** Expired leases, reclaimable. */
    index("instance_deliveries_status_lease_until_id_idx").on(t.status, t.leaseUntil, t.id),
    /** The expiry sweep's leading btree. */
    index("instance_deliveries_expires_at_idx").on(t.expiresAt),
    checkOneOf("instance_deliveries_status_check", t.status, DELIVERY_STATUSES),
    check("instance_deliveries_attempts_check", sql`${t.attempts} >= 0`),
  ],
);
