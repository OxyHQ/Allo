import Report, { type LeanReport } from "../../models/Report";
import { logger } from "../../utils/logger";
import { getCrowdSourceClient } from "./crowdSourceClient";
import { buildModerationReportInput } from "./EvidenceSnapshotService";
import type { ModerationOutboxEvent } from "./ModerationOutboxService";

/**
 * Delivering a stored report to CrowdSource.
 *
 * Everything hard about this is handled elsewhere and the shape of this file is
 * what is left over: the SDK owns the envelope, the idempotency key, the timeouts,
 * the per-attempt retries and the classification of failures; the outbox owns
 * durability, backoff and dead-lettering. What remains is to describe the material,
 * hand it over, and write down what came back.
 *
 * The failures are as important as the success:
 *
 * - **Nowhere to send it.** The integration is not configured. The event stays
 *   pending, untouched, and delivers when it is — a delay, never a loss.
 * - **The account is gone.** Deleted between the report and its delivery. There is
 *   nothing to review, so the report closes locally instead of retrying for days.
 * - **The type has no provider.** Unreachable by design — such a report never gets
 *   a delivery event — so an event that reaches it is a defect and is dead-lettered
 *   rather than retried or filed as a state.
 * - **Anything else** is the SDK's `retryable` to answer, and the outbox obeys it.
 */

const MAX_ERROR_LENGTH = 2_000;

/** Thrown when there is nowhere to deliver to yet. Always retryable. */
export class CrowdSourceUnavailableError extends Error {
  readonly retryable = true;

  constructor() {
    super("The CrowdSource integration is not configured in this deployment.");
    this.name = "CrowdSourceUnavailableError";
  }
}

/**
 * A delivery event that cannot become deliverable.
 *
 * `retryable: false` is the field the outbox reads to dead-letter instead of
 * backing off — the same contract every error from `@oxyhq/crowdsource` answers.
 */
export class ModerationDeliveryRejectedError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "ModerationDeliveryRejectedError";
  }
}

/** Close a report there is genuinely nothing left to do about. */
async function closeUndeliverable(reportId: string, reason: string): Promise<void> {
  await Report.updateOne(
    { _id: reportId },
    { $set: { localStatus: "closed", localStatusReason: reason } },
  );
}

/** Handle one `report.submit` outbox event. */
export async function deliverReportOutboxEvent(
  event: ModerationOutboxEvent,
): Promise<void> {
  const reportId = event.payload.reportId;
  if (reportId === undefined) {
    throw new ModerationDeliveryRejectedError("A report.submit event carried no reportId.");
  }

  const report = await Report.findById(reportId).lean<LeanReport | null>();
  if (!report) {
    /**
     * The report is gone but its delivery event survived. Nothing to deliver and
     * nothing to fix, so the event completes — retrying would keep looking for a
     * row that no longer exists.
     */
    logger.warn("[CrowdSource] delivery event has no report", { reportId });
    return;
  }

  const crowdsource = getCrowdSourceClient();
  if (!crowdsource) throw new CrowdSourceUnavailableError();

  /**
   * A `ModerationSubjectUnsupportedError` from here is NOT caught. It carries
   * `retryable: false`, so the outbox dead-letters the event — the right channel
   * for a defect that needs a human. Catching it and writing a local state would
   * put the report in the same place as every deliberately local-only report, which
   * in Allo is most of them.
   */
  const input = await buildModerationReportInput({
    id: String(report._id),
    reportedType: report.reportedType,
    reportedId: report.reportedId,
    reporter: report.reporter,
    categories: report.categories,
    details: report.details,
    createdAt: report.createdAt,
  });

  if (input === null) {
    await closeUndeliverable(
      reportId,
      "The reported account no longer exists, so there is nothing to review.",
    );
    logger.info("[CrowdSource] report closed: subject unavailable", { reportId });
    return;
  }

  let receipt: Awaited<ReturnType<typeof crowdsource.reports.create>>;
  try {
    receipt = await crowdsource.reports.create(input.reportInput);
  } catch (error: unknown) {
    /**
     * The failure is visible on the report itself, not only in the outbox row.
     * `delivery_failed` is a state §14.3 defines and it is what the reconciliation
     * sweep reads; leaving the report at `queued` while the outbox quietly backed
     * off would hide the problem in a collection nobody looks at. Written before
     * rethrowing so the outbox still applies its own backoff or dead-letters.
     */
    await Report.updateOne(
      { _id: reportId },
      {
        $set: {
          localStatus: "delivery_failed",
          lastDeliveryError: (error instanceof Error ? error.message : String(error)).slice(
            0,
            MAX_ERROR_LENGTH,
          ),
        },
      },
    );
    throw error;
  }

  await Report.updateOne(
    { _id: reportId },
    {
      $set: {
        localStatus: "submitted",
        crowdSourceReportId: receipt.reportId,
        crowdSourceCaseId: receipt.caseId,
        crowdSourceMerged: receipt.merged,
        contentSnapshotHash: input.snapshotHash,
        submittedAt: new Date(),
      },
      $unset: { lastDeliveryError: "", localStatusReason: "" },
    },
  );

  logger.info("[CrowdSource] report delivered", {
    reportId,
    caseId: receipt.caseId,
    merged: receipt.merged,
  });
}
