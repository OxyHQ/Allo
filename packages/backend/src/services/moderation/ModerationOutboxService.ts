import type { ClientSession } from "mongoose";
import ModerationOutbox, {
  MODERATION_OUTBOX_RETENTION_SECONDS,
  type ModerationOutboxKind,
  type ModerationOutboxPayload,
} from "../../models/ModerationOutbox";

/**
 * Claiming, completing and retrying durable moderation work.
 *
 * Lease-based rather than queue-based: a worker claims a row for a bounded time,
 * and a lease that expires is reclaimable, so a process killed mid-delivery
 * strands nothing. The row IS the job — there is no second queue that can drift
 * out of sync with it.
 */

const DEFAULT_LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1_000;
const MAX_ERROR_LENGTH = 2_000;

/**
 * The attempt ceiling for a retryable failure.
 *
 * Twenty-five attempts under exponential backoff spans days, which is long enough
 * to outlast any outage worth retrying through and short enough that a permanent
 * defect stops being a background task nobody reads.
 */
const MAX_RETRYABLE_ATTEMPTS = 25;

export interface ModerationOutboxEvent {
  _id: string;
  kind: ModerationOutboxKind;
  payload: ModerationOutboxPayload;
  attempts: number;
  availableAt: Date;
  leaseOwner?: string;
  leaseUntil?: Date;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * The event id for delivering a report.
 *
 * Derived from the report, not from the request: a transaction retry or two
 * concurrent duplicate submissions upsert the SAME event rather than queueing two
 * deliveries. There is exactly one delivery event per report for the life of the
 * report, which is also what makes the CrowdSource-side idempotency key stable.
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

/**
 * Raised when an outbox event is written outside a transaction.
 *
 * Never expected at runtime. It exists so the invariant is ENFORCED rather than
 * reviewed — see {@link enqueueModerationOutboxEvent}.
 */
export class ModerationOutboxTransactionError extends Error {
  constructor(eventId: string) {
    super(
      `Refusing to enqueue moderation outbox event '${eventId}' outside a transaction: ` +
        "the domain write and this row must commit together, or a report is answered 201 " +
        "and never delivered.",
    );
    this.name = "ModerationOutboxTransactionError";
  }
}

/**
 * Write the event with the CALLER's session.
 *
 * The session is required, not optional. This is the whole point of the
 * collection: the domain write and this row commit together or not at all. An
 * overload that let a caller enqueue outside a transaction would be the one line
 * that quietly reintroduces "the report was answered 201 and then vanished".
 *
 * The type makes the session mandatory; the runtime check below makes it mandatory
 * that the session is ACTUALLY IN a transaction. A required parameter is satisfied
 * by any session — including a bare `startSession()` nobody opened a transaction
 * on, which type-checks perfectly and commits the row on its own. That is the
 * shape of the mistake worth catching: it looks exactly like correct code, it
 * passes any test that only asserts the row exists, and it fails as lost
 * moderation work with no trace on the day something restarts between the two
 * writes.
 *
 * This function is also the ONLY writer of this collection — the dispatcher claims
 * existing rows and never creates one — so nothing can be enqueued that is not
 * already in the outbox.
 */
export async function enqueueModerationOutboxEvent(
  input: {
    eventId: string;
    kind: ModerationOutboxKind;
    payload: ModerationOutboxPayload;
  },
  session: ClientSession,
): Promise<string> {
  if (!session.inTransaction()) {
    throw new ModerationOutboxTransactionError(input.eventId);
  }

  const now = new Date();
  await ModerationOutbox.updateOne(
    { _id: input.eventId },
    {
      $setOnInsert: {
        _id: input.eventId,
        kind: input.kind,
        payload: input.payload,
        status: "pending",
        attempts: 0,
        availableAt: now,
        expiresAt: new Date(now.getTime() + MODERATION_OUTBOX_RETENTION_SECONDS * 1_000),
        /**
         * `createdAt` and `updatedAt` are deliberately ABSENT.
         *
         * The schema declares `{ timestamps: true }`, so Mongoose writes both
         * paths itself on an upsert — `updatedAt` into `$set` and both into
         * `$setOnInsert`. Naming them here too puts `updatedAt` in two operators
         * of one update document, and Mongo rejects the WHOLE write:
         * `Updating the path 'updatedAt' would create a conflict at 'updatedAt'`.
         *
         * The consequence is not a missing outbox row. This runs inside
         * `createReport`'s transaction, so the abort takes the `Report` with it —
         * `POST /reports` fails for EVERY report, from the first one. Verified
         * against a real replica set on mongoose 9.7.4: report rows 0, outbox
         * rows 0.
         *
         * `claim`'s `sort: { createdAt: 1 }` still works, because `timestamps`
         * sets `createdAt` on insert.
         */
      },
    },
    { upsert: true, session },
  );
  return input.eventId;
}

function claimFilter(now: Date, eventId?: string): Record<string, unknown> {
  return {
    ...(eventId ? { _id: eventId } : {}),
    $or: [
      { status: "pending", availableAt: { $lte: now } },
      { status: "processing", leaseUntil: { $lte: now } },
    ],
  };
}

/**
 * Atomically claim one due event. An expired `processing` lease is reclaimable,
 * so a dead worker cannot strand moderation work forever.
 */
export async function claimModerationOutboxEvent(options: {
  leaseOwner: string;
  eventId?: string;
  now?: Date;
  leaseMs?: number;
}): Promise<ModerationOutboxEvent | null> {
  const now = options.now ?? new Date();
  const leaseMs = Math.max(1_000, options.leaseMs ?? DEFAULT_LEASE_MS);
  return await ModerationOutbox.findOneAndUpdate(
    claimFilter(now, options.eventId),
    {
      $set: {
        status: "processing",
        leaseOwner: options.leaseOwner,
        leaseUntil: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      },
      $inc: { attempts: 1 },
      $unset: { lastError: "" },
    },
    { new: true, sort: { createdAt: 1 } },
  )
    .select("_id kind payload attempts availableAt leaseOwner leaseUntil expiresAt createdAt")
    .lean<ModerationOutboxEvent | null>();
}

/** Complete only the lease this dispatcher currently owns. */
export async function completeModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await ModerationOutbox.updateOne(
    { _id: eventId, status: "processing", leaseOwner, leaseUntil: { $gt: now } },
    {
      $set: { status: "processed", processedAt: now, updatedAt: now },
      $unset: { leaseOwner: "", leaseUntil: "", lastError: "" },
    },
  );
  return result.modifiedCount === 1;
}

/** Extend only a live lease still owned by this dispatcher. */
export async function renewModerationOutboxEvent(
  eventId: string,
  leaseOwner: string,
  leaseMs: number,
  now: Date = new Date(),
): Promise<boolean> {
  const result = await ModerationOutbox.updateOne(
    { _id: eventId, status: "processing", leaseOwner, leaseUntil: { $gt: now } },
    { $set: { leaseUntil: new Date(now.getTime() + Math.max(1_000, leaseMs)), updatedAt: now } },
  );
  return result.matchedCount === 1;
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
 * Mongo error — is treated as retryable, because assuming a defect is permanent is
 * how a recoverable outage becomes lost moderation work.
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
 * `lastError` is the message only, bounded. It can carry no reported material
 * because Allo never puts any into a request: the sole deliverable subject is an
 * account's own profile, so there is no message, key or ciphertext for an error
 * echo to contain.
 */
export async function failModerationOutboxEvent(
  event: Pick<ModerationOutboxEvent, "_id" | "attempts">,
  leaseOwner: string,
  error: unknown,
  now: Date = new Date(),
): Promise<ModerationOutboxFailure> {
  const message = error instanceof Error ? error.message : String(error);
  const retryable = isRetryableDeliveryError(error);
  const deadLettered = !retryable || event.attempts >= MAX_RETRYABLE_ATTEMPTS;

  const result = await ModerationOutbox.updateOne(
    { _id: event._id, status: "processing", leaseOwner, leaseUntil: { $gt: now } },
    {
      $set: {
        status: deadLettered ? "dead_letter" : "pending",
        availableAt: deadLettered ? now : nextAttemptAt(event.attempts, now),
        lastError: message.slice(0, MAX_ERROR_LENGTH),
        updatedAt: now,
      },
      $unset: { leaseOwner: "", leaseUntil: "" },
    },
  );
  return { released: result.modifiedCount === 1, deadLettered };
}
