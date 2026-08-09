import {
  releaseModerationOutboxEvent,
  type ModerationOutboxEvent,
} from "../../db/moderation/moderationOutboxRepository";

/**
 * The POLICY around durable moderation work: which event id a piece of work has,
 * whether a failure is worth retrying, how far a retry backs off, and when to
 * stop.
 *
 * Every STATEMENT moved to `db/moderation/moderationOutboxRepository.ts` in the
 * port, and this file is what did not move — the decisions a database cannot
 * make. `failModerationOutboxEvent` is the clearest case: the repository writes
 * `deadLettered` and `availableAt`, and only this layer knows whether an error was
 * retryable, how many attempts have been spent and what the backoff curve is.
 *
 * What used to be here and is now gone: thin wrappers around claim, complete,
 * renew and enqueue. Each forwarded its arguments unchanged, so each was a second
 * name for one function and a place for the two to drift. Callers reach the
 * repository directly.
 *
 * The lease model itself is unchanged from Mongo: a worker claims a row for a
 * bounded time, and a lease that expires is reclaimable, so a process killed
 * mid-delivery strands nothing. The row IS the job — there is no second queue that
 * can drift out of sync with it.
 */

const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;

/**
 * The attempt ceiling for a retryable failure.
 *
 * Twenty-five attempts under exponential backoff spans days, which is long enough
 * to outlast any outage worth retrying through and short enough that a permanent
 * defect stops being a background task nobody reads.
 */
const MAX_RETRYABLE_ATTEMPTS = 25;

/**
 * The event id for delivering a report.
 *
 * Derived from the report, not from the request: a transaction retry or two
 * concurrent duplicate submissions converge on the SAME event rather than queueing
 * two deliveries. There is exactly one delivery event per report for the life of
 * the report, which is also what makes the CrowdSource-side idempotency key
 * stable.
 */
export function reportSubmitEventId(reportId: string): string {
  return `moderation:report.submit:${reportId}`;
}

/**
 * The event id for applying an inbound decision (Appendix D).
 *
 * The webhook event id is the key, so a redelivery of the same event can never
 * queue the work twice even if the dedupe claim were somehow released.
 */
export function decisionApplyEventId(eventId: string): string {
  return `moderation:decision.apply:${eventId}`;
}

function nextAttemptAt(attempts: number, now: Date): Date {
  const exponent = Math.max(0, Math.min(attempts - 1, 20));
  return new Date(now.getTime() + Math.min(1_000 * 2 ** exponent, MAX_BACKOFF_MS));
}

/**
 * A failure that says whether trying the same payload again could ever work.
 *
 * Every error `@oxyhq/crowdsource` throws carries `retryable`, which is the only
 * thing a delivery worker needs from it. Anything else — a bug in this code, a
 * database error — is treated as retryable, because assuming a defect is permanent
 * is how a recoverable outage becomes lost moderation work.
 */
export function isRetryableDeliveryError(error: unknown): boolean {
  if (typeof error === "object" && error !== null && "retryable" in error) {
    const retryable: unknown = (error as { retryable: unknown }).retryable;
    if (typeof retryable === "boolean") return retryable;
  }
  return true;
}

export interface ModerationOutboxFailure {
  released: boolean;
  deadLettered: boolean;
}

/**
 * Release a failed claim, with backoff — or stop.
 *
 * Stopping is not an optimisation. A 409 means this `externalReportId` already
 * exists at CrowdSource with a different body, and no number of retries turns two
 * payloads into one report; a 422 means the envelope is not processable. Both need
 * the payload to change, so they become `dead_letter` immediately and stay visible
 * with their error rather than accumulating attempts nobody reads.
 *
 * The error message is stored BOUNDED, and the bound now lives in the repository
 * rather than in a `slice` here — so it holds for every writer instead of for the
 * one that remembered. It can carry no reported material because Allo never puts
 * any into a request: the sole deliverable subject is an account's own profile, so
 * there is no message, key or ciphertext for an error echo to contain.
 */
export async function failModerationOutboxEvent(
  event: Pick<ModerationOutboxEvent, "id" | "attempts">,
  leaseOwner: string,
  error: unknown,
  now: Date = new Date(),
): Promise<ModerationOutboxFailure> {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = isRetryableDeliveryError(error);
  const deadLettered = !retryable || event.attempts >= MAX_RETRYABLE_ATTEMPTS;

  const released = await releaseModerationOutboxEvent({
    eventId: event.id,
    leaseOwner,
    deadLettered,
    availableAt: deadLettered ? now : nextAttemptAt(event.attempts, now),
    error: message,
    now,
  });
  return { released, deadLettered };
}
