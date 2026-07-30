import type { ClientSession } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Nothing enqueued that is not already in the outbox, in the same transaction."
 *
 * `ReportIntakeService` passes a session, and the TYPE makes that mandatory. This
 * file covers the half a type cannot: a session that exists but has no transaction
 * open. `mongoose.startSession()` returns exactly that, it type-checks perfectly,
 * and a write made with it commits on its own — so the report and its delivery
 * event would land as two independent writes while every signature in the code
 * still looked correct.
 *
 * That failure is invisible until a process dies between the two, at which point
 * moderation work is lost with no trace. Hence a runtime guard, and hence this
 * test.
 */

vi.mock("../../../models/ModerationOutbox", () => ({
  MODERATION_OUTBOX_RETENTION_SECONDS: 90 * 24 * 60 * 60,
  default: { updateOne: vi.fn() },
}));

import ModerationOutbox from "../../../models/ModerationOutbox";
import {
  ModerationOutboxTransactionError,
  decisionApplyEventId,
  enqueueModerationOutboxEvent,
  isRetryableDeliveryError,
  reportSubmitEventId,
} from "../../../services/moderation/ModerationOutboxService";

function sessionInTransaction(open: boolean): ClientSession {
  return { inTransaction: () => open } as unknown as ClientSession;
}

describe("outbox enqueue transaction coupling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ModerationOutbox.updateOne).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof ModerationOutbox.updateOne>>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to write with a session that has no open transaction", async () => {
    await expect(
      enqueueModerationOutboxEvent(
        { eventId: "e1", kind: "report.submit", payload: { reportId: "r1" } },
        sessionInTransaction(false),
      ),
    ).rejects.toBeInstanceOf(ModerationOutboxTransactionError);

    // The important half: it refused BEFORE writing anything.
    expect(ModerationOutbox.updateOne).not.toHaveBeenCalled();
  });

  it("names the consequence in the error, not just the rule", async () => {
    /**
     * The message is the only thing a person gets at 3am. It has to say what
     * breaks, not merely that a precondition failed.
     */
    await expect(
      enqueueModerationOutboxEvent(
        { eventId: "e1", kind: "report.submit", payload: { reportId: "r1" } },
        sessionInTransaction(false),
      ),
    ).rejects.toThrow(/answered 201 and never delivered/);
  });

  it("writes with the caller's session when a transaction is open", async () => {
    const session = sessionInTransaction(true);
    const eventId = await enqueueModerationOutboxEvent(
      { eventId: "e1", kind: "report.submit", payload: { reportId: "r1" } },
      session,
    );

    expect(eventId).toBe("e1");
    const [filter, update, options] = vi.mocked(ModerationOutbox.updateOne).mock.calls[0] ?? [];
    expect(filter).toEqual({ _id: "e1" });
    expect(options).toMatchObject({ upsert: true, session });
    /**
     * `$setOnInsert`, never `$set`. A redelivered or retried enqueue must not
     * reset `attempts`, `availableAt` or `status` on a row a dispatcher is already
     * working — that would re-run delivered work and restart backoff.
     */
    expect(update).toHaveProperty("$setOnInsert");
    expect(update).not.toHaveProperty("$set");
  });
});

describe("outbox event ids", () => {
  it("derives the report delivery id from the report, so retries collapse", () => {
    /**
     * Derived, not generated. Two concurrent duplicate submissions or a
     * transaction retry upsert the SAME row rather than queueing two deliveries,
     * which is also what keeps the CrowdSource-side idempotency key stable.
     */
    expect(reportSubmitEventId("abc")).toBe("moderation:report.submit:abc");
    expect(reportSubmitEventId("abc")).toBe(reportSubmitEventId("abc"));
    expect(reportSubmitEventId("abc")).not.toBe(reportSubmitEventId("abd"));
  });

  it("derives the decision id from the webhook event id", () => {
    expect(decisionApplyEventId("evt_1")).toBe("moderation:decision.apply:evt_1");
  });

  it("cannot collide across kinds for the same underlying id", () => {
    expect(reportSubmitEventId("x")).not.toBe(decisionApplyEventId("x"));
  });
});

describe("delivery error classification", () => {
  it("honours an explicit retryable:false", () => {
    expect(isRetryableDeliveryError({ retryable: false })).toBe(false);
  });

  it("honours an explicit retryable:true", () => {
    expect(isRetryableDeliveryError({ retryable: true })).toBe(true);
  });

  it("treats an unclassified failure as retryable", () => {
    /**
     * The safe default, and the direction matters: assuming a defect is permanent
     * turns a recoverable outage into lost moderation work, while assuming it is
     * transient costs a bounded number of retries.
     */
    expect(isRetryableDeliveryError(new Error("socket hang up"))).toBe(true);
    expect(isRetryableDeliveryError(undefined)).toBe(true);
    expect(isRetryableDeliveryError({ retryable: "false" })).toBe(true);
  });
});
