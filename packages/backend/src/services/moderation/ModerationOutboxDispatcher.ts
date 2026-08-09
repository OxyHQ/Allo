import { randomUUID } from "crypto";
import { crowdSourceConfig } from "../../config/crowdsource";
import { logger } from "../../utils/logger";
import { applyDecisionOutboxEvent } from "./ModerationDecisionWorker";
import { deliverReportOutboxEvent } from "./ModerationDeliveryWorker";
import {
  claimModerationOutboxEvent,
  completeModerationOutboxEvent,
  type ModerationOutboxEvent,
} from "../../db/moderation/moderationOutboxRepository";
import { failModerationOutboxEvent } from "./ModerationOutboxService";

/**
 * The loop that drains the outbox.
 *
 * One claim at a time, in creation order, with a lease. Claiming a batch and
 * processing it concurrently would be faster and would also mean a crash mid-batch
 * left several events leased to a dead worker; one at a time keeps the failure unit
 * equal to the retry unit.
 *
 * The dispatcher is the ONLY thing gated on `CROWDSOURCE_ENABLED`. Intake still
 * writes outbox events when the integration is off, so switching it on delivers the
 * backlog rather than stranding it.
 */

const LEASE_MS = 60_000;

async function handle(event: ModerationOutboxEvent): Promise<void> {
  switch (event.kind) {
    case "report.submit":
      await deliverReportOutboxEvent(event);
      return;
    case "decision.apply":
      await applyDecisionOutboxEvent(event);
      return;
    default: {
      /**
       * An exhaustive switch, checked by the compiler. A `kind` added to the model
       * without a handler here is a type error at build time rather than an event
       * that is claimed, silently does nothing, and completes.
       */
      const unhandled: never = event.kind;
      throw new Error(`Unhandled moderation outbox kind: ${String(unhandled)}`);
    }
  }
}

export interface ModerationDispatchResult {
  claimed: number;
  processed: number;
  failed: number;
}

/**
 * Drain up to `batchSize` due events.
 *
 * Returns counts rather than throwing: a single failing event is a normal
 * condition the outbox already handles with backoff, and a scheduler that crashed
 * on it would stop draining every OTHER event too.
 */
export async function dispatchModerationOutbox(options?: {
  batchSize?: number;
  leaseOwner?: string;
}): Promise<ModerationDispatchResult> {
  const config = crowdSourceConfig();
  const result: ModerationDispatchResult = { claimed: 0, processed: 0, failed: 0 };
  if (!config.enabled) return result;

  const leaseOwner = options?.leaseOwner ?? `allo-${randomUUID()}`;
  const batchSize = Math.max(1, options?.batchSize ?? config.outboxBatchSize);

  for (let index = 0; index < batchSize; index += 1) {
    const event = await claimModerationOutboxEvent({ leaseOwner, leaseMs: LEASE_MS });
    if (!event) break;
    result.claimed += 1;

    try {
      await handle(event);
      await completeModerationOutboxEvent(event.id, leaseOwner);
      result.processed += 1;
    } catch (error: unknown) {
      const { deadLettered } = await failModerationOutboxEvent(event, leaseOwner, error);
      result.failed += 1;
      /**
       * The event id and kind, never the payload. A payload can carry a decision
       * about an account, and an operational log is not where that belongs.
       */
      logger.warn("[CrowdSource] outbox event failed", {
        eventId: event.id,
        kind: event.kind,
        attempts: event.attempts,
        deadLettered,
      });
    }
  }

  return result;
}

let timer: NodeJS.Timeout | undefined;
let running = false;

/**
 * Start the periodic drain.
 *
 * `unref()` so this timer never keeps the process alive on its own — the
 * convention for every module-level interval in the Oxy backends, and the
 * difference between a clean shutdown and a task that will not exit.
 *
 * `running` guards against overlap: a slow drain must not have a second one
 * started on top of it, which would double every lease contention.
 */
export function startModerationOutboxDispatcher(): void {
  const config = crowdSourceConfig();
  if (!config.enabled || timer) return;

  timer = setInterval(() => {
    if (running) return;
    running = true;
    void dispatchModerationOutbox()
      .catch((error: unknown) => {
        logger.error("[CrowdSource] outbox dispatch failed", error);
      })
      .finally(() => {
        running = false;
      });
  }, config.outboxPollIntervalMs);
  timer.unref?.();

  logger.info("[CrowdSource] outbox dispatcher started", {
    intervalMs: config.outboxPollIntervalMs,
  });
}

/** Stop the periodic drain. Tests and shutdown. */
export function stopModerationOutboxDispatcher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = undefined;
}
