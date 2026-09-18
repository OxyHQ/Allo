/**
 * The registry of rows that expire, and the sweep that deletes them.
 *
 * Postgres has no TTL index. A table whose rows carry an `expires_at` deadline
 * grows forever unless something deletes them — with no error, no failing test
 * and no symptom until disk. This registry names every such table, and
 * {@link startExpirySweep} is the caller that actually runs it; `server.ts` is
 * that caller's one call site. A registry nothing schedules reaps exactly as
 * much as no registry at all, and it is the shape of that omission that makes it
 * dangerous: the list LOOKS like the work. `__tests__/db/schema.realdb.test.ts`
 * therefore asserts that `server.ts` actually starts the sweep, by reading the
 * file, rather than only that the list is well formed.
 *
 * Every entry has `retentionSeconds: 0`: the column already IS the deadline,
 * set by the writer, so the sweep deletes a row once that instant has passed.
 *
 * A new table with a deadline column belongs here AND needs a leading btree
 * index on that column, which `findUnsupportedExpiryColumns` checks against the
 * real catalogue in the schema suite.
 */

import { sweepAllExpiredRows, type ExpirySweepResult, type ExpirySweepTarget } from "@oxy.so/db/expiry";
import type { AlloDatabase } from "./index";
import { expireDueOffers } from "./platform/historyRepository";
import { blobs } from "./schema/blobs";
import { instanceDeliveries } from "./schema/deliveries";
import { historyOffers } from "./schema/history";
import { moderationEvents, moderationOutbox } from "./schema/moderation";

export const EXPIRY_SWEEP_TARGETS: readonly ExpirySweepTarget[] = [
  {
    table: moderationEvents,
    column: moderationEvents.expiresAt,
    retentionSeconds: 0,
    reason:
      "Inbound CrowdSource webhook dedupe entries, kept 90 days by the writer. " +
      "Deleting one lets a redelivery of that same event be processed a second " +
      "time — which is why the deadline is 90 days and not 90 minutes; a case " +
      "can legitimately sit open for weeks.",
  },
  {
    table: moderationOutbox,
    column: moderationOutbox.expiresAt,
    retentionSeconds: 0,
    reason:
      "Outbound moderation work, kept 90 days by the writer. THIS TABLE CAN " +
      "HOLD UNPROCESSED WORK: a `pending` or `dead_letter` row that reaches its " +
      "deadline is destroyed by this sweep, so a dispatcher stalled for 90 days " +
      "silently loses the reports it never delivered. The ceiling exists to stop " +
      "the table growing without bound; alerting on outbox age is what has to " +
      "fire long before it, and that alerting is not this sweep's job.",
  },
  {
    table: instanceDeliveries,
    column: instanceDeliveries.expiresAt,
    retentionSeconds: 0,
    reason:
      "Per-instance delivery stream entries, dated 30 days out at insert. A " +
      "delivery still unacked at its deadline is dropped from the STREAM " +
      "(`GET /v1/sync` will not return it again); the event itself stays in " +
      "`conversation_events` and a client that was away that long refetches " +
      "through `GET /v1/conversations/:id/events`. The row is what makes the " +
      "cursor dense, so the deadline is the bound on how far behind a device " +
      "may fall before it has to resync rather than catch up.",
  },
  {
    table: blobs,
    column: blobs.expiresAt,
    retentionSeconds: 0,
    reason:
      "Uploaded blobs nobody referenced within seven days. `expires_at` is " +
      "cleared to NULL the moment an event names the blob in its `blobIds`, so " +
      "a dated row is by definition one no message points at. Deleting it " +
      "cascades to `blob_bytes`. The blob collector (`workers/blobGc.ts`) " +
      "covers the case this sweep cannot see: an unreferenced blob whose " +
      "uploader instance was revoked before the seven days ran out.",
  },
  {
    table: historyOffers,
    column: historyOffers.expiresAt,
    retentionSeconds: 0,
    reason:
      "History offers, dated seven days out at insert (`HISTORY_OFFER_TTL_MS`). " +
      "A pending offer the recipient never consumed is gone at its deadline, " +
      "along with the consumed and expired rows, which are only a record. The " +
      "row's chunk blobs are NOT deleted here: `releaseDueHistoryOffers` runs " +
      "ahead of this sweep in `runExpirySweep` and dates them a day out, so " +
      "the blob sweep above reaps them on its own schedule.",
  },
];

/**
 * Mark every pending offer past its deadline `expired` and date its chunks.
 *
 * Runs in {@link runExpirySweep} BEFORE the deletes, in its own transaction, so
 * a `history_offers` row is never deleted while its chunk blobs still carry
 * `expires_at = null`. The sweep itself is a plain delete and cannot do this,
 * and the alternative — leaving it to the hourly blob collector — is a race the
 * minute-cadence sweep wins almost every time. The collector's orphan pass
 * stays as the backstop for a row that goes some other way.
 */
export async function releaseDueHistoryOffers(db: AlloDatabase, now = new Date()): Promise<number> {
  return db.transaction((tx) => expireDueOffers(now, undefined, tx));
}

/**
 * Run every target once.
 *
 * Always logs, whether or not it deleted anything: a sweep that reaps nothing
 * and a sweep that never ran are otherwise indistinguishable, and the second is
 * the failure this whole module exists to make impossible.
 */
export async function runExpirySweep(
  db: AlloDatabase,
  log: { info: (message: string) => void; debug: (message: string) => void },
): Promise<readonly ExpirySweepResult[]> {
  const released = await releaseDueHistoryOffers(db);
  if (released > 0) log.info(`history offers expired ahead of the sweep: count=${released}`);
  const results = await sweepAllExpiredRows(db, EXPIRY_SWEEP_TARGETS);
  const deleted = results.reduce((total, result) => total + result.deleted, 0);
  const summary = `expiry sweep: tablesSwept=${results.length} deleted=${deleted}`;
  if (deleted > 0) log.info(summary);
  else log.debug(summary);
  return results;
}

/**
 * How often the sweep runs.
 *
 * 60 seconds is the reaping latency the writers were built against.
 * `moderation_events` is a webhook dedupe table, and how long a deleted entry
 * stays deleted-but-not-yet-reaped is the window in which a redelivery is
 * processed twice.
 */
export const EXPIRY_SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start sweeping, and sweep once immediately.
 *
 * The immediate pass is not impatience: a task that restarts more often than the
 * interval would otherwise never sweep at all, and a deploy loop is exactly when
 * that happens. It also puts one line in the boot log saying the sweep is alive,
 * which is the difference between "reaped nothing" and "never ran" that the
 * whole module exists to preserve.
 *
 * Every failure is caught and logged rather than rethrown. This runs detached
 * from any request, so an unhandled rejection here would take the process down
 * over a transient database blip — and the next tick retries anyway.
 *
 * `.unref()` so the timer cannot by itself hold the event loop open; the HTTP
 * server is what keeps the process alive, and a test that imports this module
 * must not hang because of it.
 */
export function startExpirySweep(
  db: AlloDatabase,
  log: { info: (message: string) => void; debug: (message: string) => void; error: (message: string, error: unknown) => void },
): void {
  if (sweepTimer) return;

  const sweep = (): void => {
    void runExpirySweep(db, log).catch((error: unknown) => {
      log.error("expiry sweep failed", error);
    });
  };

  sweep();
  sweepTimer = setInterval(sweep, EXPIRY_SWEEP_INTERVAL_MS);
  sweepTimer.unref?.();
}

/** Stop sweeping. Exists for tests and for an orderly shutdown. */
export function stopExpirySweep(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
