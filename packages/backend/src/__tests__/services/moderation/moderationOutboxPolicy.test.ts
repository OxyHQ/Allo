import { describe, expect, it } from "vitest";

import { MissingTransactionError } from "../../../db/moderation/transactionGuard";
import {
  decisionApplyEventId,
  isRetryableDeliveryError,
  reportSubmitEventId,
} from "../../../services/moderation/ModerationOutboxService";

/**
 * What is left of `ModerationOutboxService` once the statements moved to the
 * repository: the decisions a database cannot make.
 *
 * This file was `moderationOutboxTransaction.test.ts`, and the half it lost is
 * the reason for the rename. Its transaction-coupling cases asserted the guard
 * against a MOCKED model — that a refusal happened before `updateOne` was called,
 * and that an accepted write carried `$setOnInsert` rather than `$set`. Both are
 * now asserted against a real server in `db/moderation.realdb.test.ts`, which can
 * do what a mock cannot: refuse the actual root connection, and prove that a
 * repeated enqueue moves neither `updated_at` nor the row's `xmin`.
 *
 * Keeping a mocked copy beside the real one would be worse than redundant. A mock
 * can be made to agree with any claim about the database, so the two would agree
 * right up to the day the real behaviour changed and only one of them noticed.
 *
 * What remains here needs no database at all, and that is why it is still a unit
 * test: pure functions whose value is their exact output.
 */

describe("the refusal message", () => {
  it("names the consequence, not just the rule", () => {
    /**
     * The message is the only thing a person gets at 3am. It has to say what
     * breaks, not merely that a precondition failed.
     */
    expect(new MissingTransactionError("enqueueModerationOutboxEvent(evt-1)").message).toMatch(
      /answered 201 and never delivered/,
    );
  });

  it("names the CALL that was misrouted, not only the function", () => {
    /**
     * The callers pass the event id too, so a refusal says which enqueue went
     * wrong instead of sending whoever hits it hunting through every caller.
     */
    expect(new MissingTransactionError("enqueueModerationOutboxEvent(evt-1)").message).toContain(
      "evt-1",
    );
  });
});

describe("outbox event ids", () => {
  it("derives the report delivery id from the report, so retries collapse", () => {
    /**
     * Derived, not generated. Two concurrent duplicate submissions or a
     * transaction retry converge on the SAME row rather than queueing two
     * deliveries, which is also what keeps the CrowdSource-side idempotency key
     * stable.
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
