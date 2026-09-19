/**
 * THE RING THAT NOBODY ANSWERED.
 *
 * Every other ending a call has is somebody's decision, reported by their
 * device. This one is the absence of a decision, so the only thing that can
 * notice it is the server — and it has to, because the caller's phone may be
 * in a pocket on a train by then.
 *
 * `claimExpiredRings` is an UPDATE that both finds and settles, so when two
 * ECS tasks sweep on the same second exactly one of them owns each call and
 * exactly one set of devices is told. Finding first and settling second is the
 * shape that rings a call off twice.
 *
 * Not leader-gated, for the same reason the delivery worker is not: the claim
 * is atomic, so more tasks sweeping is more throughput rather than more risk.
 */

import { CALL_RING_TIMEOUT_MS } from "@allo/shared-types";
import type { AlloDatabase } from "../db";
import { getDb } from "../db";
import { claimExpiredRings, listParticipants, settleRingingParticipants } from "../db/platform/callRepository";
import { getRealtime } from "../runtime/realtime";
import { logger } from "../utils/logger";

/** How often the sweep runs. A quarter of the ring, so a missed call is noticed within about ten seconds of its deadline. */
export const CALL_RING_TICK_MS = Math.round(CALL_RING_TIMEOUT_MS / 4);
/** How many rings one tick settles. A burst bigger than this is caught by the next one. */
const BATCH = 100;

export interface CallRingTickResult {
  missed: number;
}

export async function runCallRingTick(deps: { db?: AlloDatabase; now?: () => Date } = {}): Promise<CallRingTickResult> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();
  const expired = await claimExpiredRings(now, BATCH, db);
  if (expired.length === 0) return { missed: 0 };

  const realtime = getRealtime();
  for (const call of expired) {
    try {
      await settleRingingParticipants(call.id, "missed", now, db);
      const audience = [call.initiatorInstanceId, ...(await listParticipants(call.id, db)).map((one) => one.instanceId)];
      for (const instanceId of new Set(audience)) {
        realtime.callUpdated(instanceId, {
          callId: call.id,
          state: "ended",
          answeredByInstanceId: null,
          endReason: "missed",
        });
      }
    } catch (error: unknown) {
      // One call that cannot be settled must not stop the rest of the batch.
      logger.debug("ring expiry failed for a call", error);
    }
  }
  logger.info(`call rings expired: count=${expired.length}`);
  return { missed: expired.length };
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;

export function startCallRingWorker(deps: { db?: AlloDatabase } = {}): void {
  if (timer) return;
  timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void runCallRingTick(deps)
      .catch((error: unknown) => logger.warn("call ring sweep failed", error))
      .finally(() => {
        inFlight = false;
      });
  }, CALL_RING_TICK_MS);
  timer.unref?.();
  logger.info("call ring worker started");
}

export async function stopCallRingWorker(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  inFlight = false;
}
