import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What Allo does when a decision comes back — and, just as importantly, what it
 * does not do.
 *
 * Allo has no platform-level sanction primitive: `Block` and `Restrict` are
 * per-user relations a user writes about their own inbox, not account-level
 * penalties. So the decision worker records the action it WOULD take and never
 * acts, in every enforcement mode. The tests below pin that, because "moderation
 * silently started restricting accounts" is not a regression anyone would want to
 * discover from a user report.
 */

vi.mock("../../../models/Report", async () => {
  const actual = await vi.importActual<typeof import("../../../models/Report")>(
    "../../../models/Report",
  );
  return { ...actual, default: { findOne: vi.fn(), updateOne: vi.fn() } };
});

import Report from "../../../models/Report";
import { resetCrowdSourceConfigForTests } from "../../../config/crowdsource";
import {
  applyDecisionOutboxEvent,
  plannedActionForOutcome,
} from "../../../services/moderation/ModerationDecisionWorker";
import {
  legacyStatusForOutcome,
  reportStateForDecision,
} from "../../../services/moderation/reportStatus";
import { ReportStatus } from "../../../models/Report";
import type { ModerationOutboxEvent } from "../../../services/moderation/ModerationOutboxService";

const CASE_ID = "case_1";
const REPORT_ID = new mongoose.Types.ObjectId();

/**
 * A decision that actually satisfies `DecisionSchema`.
 *
 * Built out in full rather than cast into shape, because the contract carries
 * cross-field invariants a hand-waved fixture would not exercise: a `violation`
 * requires at least one finding, a revision after the first must name what it
 * supersedes, and `jury.agreement` must equal `winningVotes / decisiveVotes`. A
 * fixture that skipped them would make every test here pass through the parse
 * failure branch instead of the one it claims to test — which is exactly what the
 * first draft of this file did.
 */
function decision(overrides: Record<string, unknown> = {}) {
  return {
    id: "dec_1",
    caseId: CASE_ID,
    revision: 2,
    supersedesDecisionId: "dec_0",
    status: "final",
    outcome: "violation",
    contextSufficiency: "sufficient",
    confidence: 0.9,
    findings: [
      {
        code: "harassment.targeted_abuse",
        severity: "high",
        scope: "application_local",
        confidence: 0.9,
        resourceIds: ["res_1"],
      },
    ],
    recommendedActions: [],
    jury: {
      size: 5,
      decisiveVotes: 5,
      winningVotes: 4,
      agreement: 0.8,
      specialistPresent: false,
    },
    policyVersions: {
      taxonomy: "2026.07",
      application: "allo-2026.07",
      oxyConduct: "2026.07",
    },
    publishedAt: new Date().toISOString(),
    ...overrides,
  };
}

function event(decisionPayload: unknown): ModerationOutboxEvent {
  return {
    _id: "moderation:decision.apply:evt_1",
    kind: "decision.apply",
    payload: { eventId: "evt_1", caseId: CASE_ID, decision: decisionPayload },
    attempts: 1,
    availableAt: new Date(),
    expiresAt: new Date(Date.now() + 1000),
    createdAt: new Date(),
  };
}

describe("decision application", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCrowdSourceConfigForTests();
    vi.mocked(Report.updateOne).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof Report.updateOne>>,
    );
  });

  afterEach(() => {
    delete process.env.CROWDSOURCE_ENFORCEMENT_MODE;
    resetCrowdSourceConfigForTests();
    vi.restoreAllMocks();
  });

  function stubReport(stored: { decisionRevision?: number } = {}) {
    vi.mocked(Report.findOne).mockReturnValue({
      lean: async () => ({ _id: REPORT_ID, ...stored }),
    } as unknown as ReturnType<typeof Report.findOne>);
  }

  it("records the outcome and the action it WOULD take, never one it did", async () => {
    stubReport();
    await applyDecisionOutboxEvent(event(decision()));

    const update = vi.mocked(Report.updateOne).mock.calls[0]?.[1];
    expect(update).toMatchObject({
      $set: expect.objectContaining({
        decisionOutcome: "violation",
        decisionRevision: 2,
        enforcedAction: "restrict",
        status: ReportStatus.RESOLVED,
        localStatus: "closed",
      }),
    });

    /**
     * The load-bearing negative. `enforcedAt` is what would distinguish "we
     * decided this" from "we did this", and nothing in Allo may set it until an
     * enforcement mechanism actually exists.
     */
    const setFields = (update as { $set: Record<string, unknown> }).$set;
    expect(setFields).not.toHaveProperty("enforcedAt");
  });

  it("does not act even in automatic mode, because there is nothing to act with", async () => {
    process.env.CROWDSOURCE_ENFORCEMENT_MODE = "automatic";
    resetCrowdSourceConfigForTests();
    stubReport();

    await applyDecisionOutboxEvent(event(decision()));

    const update = vi.mocked(Report.updateOne).mock.calls[0]?.[1];
    const setFields = (update as { $set: Record<string, unknown> }).$set;
    expect(setFields).not.toHaveProperty("enforcedAt");
    // Only the report row is touched. No Block, no Restrict, no user write.
    expect(Report.updateOne).toHaveBeenCalledTimes(1);
  });

  it("ignores a revision that is not newer than the one already stored", async () => {
    /**
     * §10.6 allows redelivery and reordering, so an older revision arriving late
     * must never overwrite a newer one. Compared against what is STORED, not
     * against arrival order.
     */
    stubReport({ decisionRevision: 5 });
    await applyDecisionOutboxEvent(event(decision({ revision: 3 })));
    expect(Report.updateOne).not.toHaveBeenCalled();

    await applyDecisionOutboxEvent(event(decision({ revision: 5 })));
    expect(Report.updateOne).not.toHaveBeenCalled();
  });

  it("applies a strictly newer revision", async () => {
    stubReport({ decisionRevision: 5 });
    await applyDecisionOutboxEvent(event(decision({ revision: 6 })));
    expect(Report.updateOne).toHaveBeenCalledTimes(1);
  });

  it("retries — never dead-letters — a decision it cannot parse", async () => {
    /**
     * A payload this deployment cannot parse is far more likely to be a newer
     * CrowdSource than a corrupt one. The outbox keeps a retryable failure for
     * days, which is long enough to ship a contracts bump and let the backlog
     * apply itself; dead-lettering would discard a real decision because this
     * deployment was behind.
     */
    stubReport();
    const thrown = await applyDecisionOutboxEvent(event({ nonsense: true })).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toHaveProperty("retryable", false);
    expect(Report.updateOne).not.toHaveBeenCalled();
  });

  it("is a no-op when no local report matches the case", async () => {
    // A merged case (§7.3) can name a case another report opened. Nothing to apply.
    vi.mocked(Report.findOne).mockReturnValue({
      lean: async () => null,
    } as unknown as ReturnType<typeof Report.findOne>);

    await expect(applyDecisionOutboxEvent(event(decision()))).resolves.toBeUndefined();
    expect(Report.updateOne).not.toHaveBeenCalled();
  });

  it("dead-letters an event with no caseId", async () => {
    const malformed: ModerationOutboxEvent = {
      ...event(decision()),
      payload: { eventId: "evt_1" },
    };
    await expect(applyDecisionOutboxEvent(malformed)).rejects.toHaveProperty(
      "retryable",
      false,
    );
  });
});

describe("outcome mapping", () => {
  it("maps only real verdicts to verdict statuses", () => {
    expect(legacyStatusForOutcome("violation")).toBe(ReportStatus.RESOLVED);
    expect(legacyStatusForOutcome("no_violation")).toBe(ReportStatus.DISMISSED);
  });

  it("never turns 'we could not tell' into 'nothing was wrong'", () => {
    /**
     * The collapse the invariants forbid: absence of consensus is neither guilt
     * nor innocence. Every non-verdict outcome — and any outcome a newer
     * CrowdSource invents — maps to `reviewed`, never `dismissed`.
     */
    for (const outcome of [
      "insufficient_context",
      "inconclusive",
      "content_unavailable",
      "duplicate",
      "escalated",
      "an_outcome_from_the_future",
    ]) {
      expect(legacyStatusForOutcome(outcome)).toBe(ReportStatus.REVIEWED);
    }
  });

  it("keeps a provisional decision open and closes a final one", () => {
    expect(
      reportStateForDecision({ outcome: "violation", decisionStatus: "provisional" })
        .localStatus,
    ).toBe("submitted");
    expect(
      reportStateForDecision({ outcome: "violation", decisionStatus: "final" }).localStatus,
    ).toBe("closed");
    expect(
      reportStateForDecision({ outcome: "violation", decisionStatus: "corrected" })
        .localStatus,
    ).toBe("closed");
    /**
     * A superseded revision is not the current answer and must never be the thing
     * that closes the report.
     */
    expect(
      reportStateForDecision({ outcome: "violation", decisionStatus: "superseded" })
        .localStatus,
    ).toBe("submitted");
  });

  it("routes a non-verdict to a person rather than to silence", () => {
    expect(plannedActionForOutcome("violation")).toBe("restrict");
    expect(plannedActionForOutcome("no_violation")).toBe("restore");
    expect(plannedActionForOutcome("inconclusive")).toBe("manual_review");
    expect(plannedActionForOutcome("insufficient_context")).toBe("manual_review");
  });
});
