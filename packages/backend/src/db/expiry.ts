/**
 * The registry that replaces this service's Mongo TTL indexes.
 *
 * Mongo reaped three collections with no code anywhere in this repository:
 * `moderation_events`, `moderation_outbox` and `bridgelinksessions` each
 * declared `{ expiresAt: 1 }, { expireAfterSeconds: 0 }`, and the server deleted
 * the rows itself. **All three indexes were confirmed present on the live
 * `allo-production` database**, so the reaping is real behaviour this port must
 * reproduce, not a declaration that never took effect.
 *
 * Postgres has no TTL index. Without this registry AND a caller that runs it,
 * the three tables grow forever — with no error, no failing test and no symptom
 * until disk. It is invisible in a diff because the thing doing the work was
 * never in this codebase to go missing.
 *
 * `expireAfterSeconds: 0` means "delete once the instant in `expiresAt` has
 * passed", so every entry here has `retentionSeconds: 0`: the column already IS
 * the deadline. That is a faithful translation, not a shortcut.
 *
 * The registry is only half of it. {@link startExpirySweep} is the other half and
 * `server.ts` is its one caller — a registry nothing schedules reaps exactly as
 * much as no registry at all, and it is the shape of that omission that makes it
 * dangerous: the list LOOKS like the work. `__tests__/db/schema.realdb.test.ts`
 * therefore asserts that `server.ts` actually starts the sweep, by reading the
 * file, rather than only that the list is well formed.
 */

import { sweepAllExpiredRows, type ExpirySweepResult, type ExpirySweepTarget } from "@oxyhq/db/expiry";
import type { SqlExecutor } from "@oxyhq/db";
import { bridgeLinkSessions } from "./schema/bridges";
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
    table: bridgeLinkSessions,
    column: bridgeLinkSessions.expiresAt,
    retentionSeconds: 0,
    reason:
      "An in-flight bridge linking attempt. Past its deadline the remote login " +
      "process is gone and the row can only produce a session that cannot be " +
      "resumed. Deleting it also drops the historical record of an ATTEMPT — " +
      "which is what Mongo already did, so keeping them would be a new policy " +
      "rather than a preserved one.",
  },
];

/**
 * Run every target once.
 *
 * Always logs, whether or not it deleted anything: a sweep that reaps nothing
 * and a sweep that never ran are otherwise indistinguishable, and the second is
 * the failure this whole module exists to make impossible.
 */
export async function runExpirySweep(
  db: SqlExecutor,
  log: { info: (message: string) => void; debug: (message: string) => void },
): Promise<readonly ExpirySweepResult[]> {
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
 * 60 seconds because that is the period of Mongo's own TTL monitor, which is
 * what these three tables were reaped by until now. A faithful port keeps the
 * reaping latency the writers were built against rather than picking a new
 * number: `moderation_events` is a webhook dedupe table, and how long a deleted
 * entry stays deleted-but-not-yet-reaped is the window in which a redelivery is
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
  db: SqlExecutor,
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
