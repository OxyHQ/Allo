import { createHash } from "crypto";
import type { ReportInput } from "@oxyhq/crowdsource";
import { REPORT_TAXONOMY_VERSION, allegationsForCategories } from "./reportTaxonomy";
import { subjectProviderFor } from "./subjects/registry";
import type { ModerationSubjectSnapshot } from "./subjects/types";
import type { IReport } from "../../models/Report";

/**
 * Turning a stored report into the thing the SDK delivers.
 *
 * `@oxyhq/crowdsource` builds the Case Envelope, and it deliberately does not
 * export the function that does it. What this module produces is the SDK's
 * `ReportInput` — a description of the material — and the SDK derives the envelope
 * from it: resource ids, relations, digests, pseudonymous principal refs, the
 * identity binding proof, the pinned policy version, the privacy terms and the
 * idempotency key.
 *
 * That is not a technicality. Those derived values are exactly what §7.3's dedup
 * key is computed over, so an application that composed its own envelope would be
 * the reason two reporters about one account opened two cases — and "one penalty
 * per incident" would fail in production with nothing failing in a test.
 *
 * So this module does three things and no more: ask the registry for a snapshot of
 * the reported object, translate the reporter's categories into allegations, and
 * assemble both with the report's own identity.
 */

/**
 * The material could not be described, because nothing can describe it.
 *
 * This is a DEFECT, not a state, and it should be unreachable. A report whose type
 * has no subject provider never gets a delivery event in the first place — intake
 * decides that from the same registry this module reads — so an event that arrives
 * here has been created by something that bypassed `ReportIntakeService`, or by a
 * deployment where a provider was removed while its reports were still in flight.
 *
 * `retryable: false` therefore dead-letters the outbox event, so the reconciliation
 * sweep counts it and a human looks. The alternative — writing a local state —
 * would file a genuine defect in the one place that looks identical to the
 * deliberate local-only reports, and in Allo that place is crowded: every reported
 * message lives there. Nothing would ever alert on it.
 */
export class ModerationSubjectUnsupportedError extends Error {
  readonly retryable = false;

  constructor(reportedType: string) {
    super(`No moderation subject provider is registered for '${reportedType}'.`);
    this.name = "ModerationSubjectUnsupportedError";
  }
}

/**
 * SHA-256 of the snapshot, stored on the report (§5.6).
 *
 * Taken over the described MATERIAL, not over the whole `ReportInput`: the report
 * id, the reporter and the allegations are properties of the report, and including
 * them would mean two people reporting one account produced different hashes —
 * the opposite of what this hash is for. Key order is fixed by the literal below
 * rather than by `Object.keys`, so the digest is stable across Node versions and
 * across a refactor that reorders a field.
 */
export function snapshotHash(snapshot: ModerationSubjectSnapshot): string {
  const canonical = JSON.stringify({
    subject: {
      externalId: snapshot.subject.externalId,
      type: snapshot.subject.type,
      author: snapshot.subject.author?.oxyUserId ?? null,
    },
    content: snapshot.content,
    attachments: snapshot.attachments ?? [],
    context: snapshot.context ?? [],
  });
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

export interface ModerationReportInput {
  /** What the SDK delivers. */
  readonly reportInput: ReportInput;
  /** The digest to store on the local report. */
  readonly snapshotHash: string;
}

/**
 * Describe a stored report for delivery, or report why it cannot be described.
 *
 * Returns `null` when the reported object no longer exists. That is not an error
 * either: an account deleted between the report and its delivery is ordinary.
 */
export async function buildModerationReportInput(
  report: Pick<
    IReport,
    "reportedType" | "reportedId" | "reporter" | "categories" | "details" | "createdAt"
  > & { id: string },
): Promise<ModerationReportInput | null> {
  const provider = subjectProviderFor(report.reportedType);
  if (!provider) throw new ModerationSubjectUnsupportedError(report.reportedType);

  const snapshot = await provider.snapshot(report.reportedId);
  if (!snapshot) return null;

  const allegationCodes = allegationsForCategories(report.categories);
  const details = report.details?.trim();

  return {
    reportInput: {
      externalReportId: report.id,
      subject: snapshot.subject,
      content: snapshot.content,
      ...(snapshot.attachments === undefined ? {} : { attachments: snapshot.attachments }),
      ...(snapshot.context === undefined ? {} : { context: snapshot.context }),
      /**
       * The reporter's own words ride on the FIRST allegation only.
       *
       * Repeating one free-text field across every code would say the reporter
       * wrote it about each of them separately, and §6.2 is explicit that details
       * are the reporter's claim and never evidence for it.
       *
       * This is the ONLY free text Allo sends, and it is the reporter's own — the
       * one place a reporter could choose to paste something a message said. That
       * is their disclosure to make about their own conversation, bounded to 500
       * characters by the schema, and it is attributed to them as a claim rather
       * than presented as evidence of what was said.
       */
      allegations: allegationCodes.map((code, index) =>
        index === 0 && details ? { code, details } : { code },
      ),
      /**
       * The Oxy subject IS the binding proof (§11.14). Allo stores reporters as Oxy
       * user ids, so there is no separate binding step to implement here.
       */
      reportedBy: { oxyUserId: report.reporter },
      /**
       * The moment the USER reported it — the local report's own timestamp, not the
       * moment of delivery. Any value invented per attempt would make every retry
       * from the outbox a permanent 409 (§10.5).
       */
      submittedAt: report.createdAt,
      metadata: {
        /** So a case can be read back against the mapping that produced it. */
        alloTaxonomyVersion: REPORT_TAXONOMY_VERSION,
        alloCategories: [...report.categories].sort().join(","),
        /**
         * Declared, and permanently false in Allo.
         *
         * Not "not implemented yet" — there is no evidence to attach. Allo is
         * end-to-end encrypted and the server cannot read a message, so a jury will
         * never receive conversation material with a case from this application. A
         * jury told this can answer `insufficient_context` for the right reason
         * rather than assuming evidence was withheld or lost.
         */
        evidenceAttachmentsSupported: false,
      },
    },
    snapshotHash: snapshotHash(snapshot),
  };
}
