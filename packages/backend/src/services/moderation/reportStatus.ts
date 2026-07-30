import { ReportStatus, type ModerationLocalStatus } from "../../models/Report";

/**
 * The one place a report's two status axes are decided.
 *
 * §14.3 requires the legacy `status` field to keep working rather than being
 * renamed destructively. Two status fields maintained by two call sites is how
 * they drift, so both are derived here — from the decision, not from each other.
 *
 * The mapping is deliberately conservative about the difference between "a jury
 * looked at this" and "this was a violation". `resolved` and `dismissed` are the
 * two legacy values that carry a verdict, so only an outcome that IS a verdict may
 * produce them:
 *
 * - `violation` → `resolved`: the case reached a conclusion Allo can act on.
 * - `no_violation` → `dismissed`: the allegation was not upheld.
 * - `insufficient_context`, `inconclusive`, `content_unavailable`, `duplicate`,
 *   `escalated` → `reviewed`: a jury engaged and produced no verdict. Mapping any
 *   of these to `dismissed` would turn "we could not tell" into "nothing was
 *   wrong" — absence of consensus is neither guilt nor innocence.
 *
 * An outcome this version does not know also maps to `reviewed`: a newer
 * CrowdSource must not be able to silently produce `dismissed` here.
 */

/**
 * The outcome, as a string.
 *
 * Not typed as a closed union on purpose: this function is reached from the
 * decision worker with a value that came off the wire, and §10.11 requires an
 * unrecognised outcome to be handled rather than to throw.
 */
export function legacyStatusForOutcome(outcome: string): ReportStatus {
  switch (outcome) {
    case "violation":
      return ReportStatus.RESOLVED;
    case "no_violation":
      return ReportStatus.DISMISSED;
    default:
      return ReportStatus.REVIEWED;
  }
}

export interface ReportDecisionState {
  status: ReportStatus;
  localStatus: ModerationLocalStatus;
}

/**
 * Decision statuses that end Allo's side of the case.
 *
 * A `provisional` decision leaves the report at `submitted`: §9.6 allows a later
 * revision to supersede it, and a report Allo had already closed would have to be
 * reopened. `superseded` is not here either — a superseded revision is not the
 * current answer and must never be the one that closes the report.
 */
const TERMINAL_DECISION_STATUSES: ReadonlySet<string> = new Set(["final", "corrected"]);

/** Both axes for a report whose case has been decided. */
export function reportStateForDecision(input: {
  outcome: string;
  decisionStatus: string;
}): ReportDecisionState {
  return {
    status: legacyStatusForOutcome(input.outcome),
    localStatus: TERMINAL_DECISION_STATUSES.has(input.decisionStatus) ? "closed" : "submitted",
  };
}
