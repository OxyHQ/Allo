import { DecisionSchema } from "@oxyhq/crowdsource-contracts";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { uuidv7 } from "@oxyhq/db";

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

import { resetCrowdSourceConfigForTests } from "../../../config/crowdsource";
import { closePostgres, connectPostgres, getDb } from "../../../db";
import type { ModerationOutboxEvent } from "../../../db/moderation/moderationOutboxRepository";
import * as schema from "../../../db/schema";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../../db/testDatabase";
import {
  applyDecisionOutboxEvent,
  plannedActionForOutcome,
} from "../../../services/moderation/ModerationDecisionWorker";
import {
  legacyStatusForOutcome,
  reportStateForDecision,
} from "../../../services/moderation/reportStatus";

const CASE_ID = "case_1";

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
 *
 * `assertValidDecision` below is why that cannot happen again silently. See its
 * comment: a fixture for a schema this repository does not own must be checked
 * against the schema, not against what the shape looks like.
 */
function decision(overrides: Record<string, unknown> = {}) {
  return assertValidDecision({
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
  });
}

/**
 * Fail where the fixture is BUILT, not somewhere downstream.
 *
 * `DecisionSchema` belongs to `@oxyhq/crowdsource-contracts`, not to this
 * repository, so a fixture written to match "what a decision looks like" is a
 * guess that stops being true the moment the contract adds a required field or
 * another cross-field invariant. When that happens the tests do not fail — they
 * quietly start running the parse-failure branch of the worker instead of the
 * branch each one claims to exercise, and they keep passing while testing
 * nothing. That is not hypothetical: it is what the first draft of this file
 * did, and two other Oxy integrations hit the same thing on the same day with
 * different hand-built fixtures.
 *
 * So the fixture is validated against the contract's own schema, once, here.
 * A drift then surfaces as "the fixture is not a Decision" — which names the
 * cause — rather than as a distant assertion failing for a reason that reads
 * like a bug in the worker.
 *
 * Deliberately NOT applied to the deliberately-invalid payloads: the "retries a
 * decision it cannot parse" test passes its own object and must stay unchecked.
 */
function assertValidDecision(candidate: Record<string, unknown>): Record<string, unknown> {
  const parsed = DecisionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Test fixture is not a valid Decision — the contract has moved. Issues:\n${parsed.error.issues
        .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n")}`,
    );
  }
  return candidate;
}

function event(decisionPayload: unknown): ModerationOutboxEvent {
  return {
    id: "moderation:decision.apply:evt_1",
    kind: "decision.apply",
    payload: { eventId: "evt_1", caseId: CASE_ID, decision: decisionPayload },
    attempts: 1,
    availableAt: new Date(),
    expiresAt: new Date(Date.now() + 1000),
    createdAt: new Date(),
  };
}

/**
 * Against a REAL Postgres server, where this file used to mock the model.
 *
 * The claims are about what ends up ON the report — an outcome recorded, a
 * revision guard that holds, and above all a column that must stay NULL — and a
 * mocked `updateOne` accepts any statement, including ones the server refuses.
 * The revision guard in particular is a compare-and-set written as
 * `is not distinct from`, which no mock can evaluate: against a mock, an `=`
 * would look identical and would silently drop the FIRST decision about every
 * report ever filed.
 */
describe("decision application", () => {
  let handle: TestDatabaseHandle;
  let reportId: string;

  beforeAll(async () => {
    handle = await setUpTestDatabase();
    connectPostgres(handle.databaseUrl);
  }, 180_000);

  afterAll(async () => {
    await closePostgres();
    await handle?.drop();
  });

  beforeEach(async () => {
    resetCrowdSourceConfigForTests();
    await getDb().delete(schema.reports);
    reportId = uuidv7();
  });

  afterEach(() => {
    delete process.env.CROWDSOURCE_ENFORCEMENT_MODE;
    resetCrowdSourceConfigForTests();
  });

  /** A submitted report awaiting a decision on {@link CASE_ID}. */
  async function seedReport(stored: { decisionRevision?: number } = {}): Promise<void> {
    await getDb()
      .insert(schema.reports)
      .values({
        id: reportId,
        reportedType: "user",
        reportedId: "oxy-user-1",
        reporter: "oxy-reporter-1",
        categories: ["harassment"],
        localStatus: "submitted",
        crowdSourceCaseId: CASE_ID,
        ...(stored.decisionRevision === undefined
          ? {}
          : { decisionRevision: stored.decisionRevision }),
      });
  }

  async function storedReport() {
    const [row] = await getDb()
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.id, reportId));
    return row;
  }

  it("records the outcome and the action it WOULD take, never one it did", async () => {
    await seedReport();
    await applyDecisionOutboxEvent(event(decision()));

    const row = await storedReport();
    expect(row).toMatchObject({
      decisionOutcome: "violation",
      decisionRevision: 2,
      enforcedAction: "restrict",
      status: "resolved",
      localStatus: "closed",
    });

    /**
     * The load-bearing negative, and it is stronger read off the row than off an
     * update document: `enforced_at` is NULL because nothing has ever written it,
     * not because one statement happened to omit it. It is what would distinguish
     * "we decided this" from "we did this", and nothing in Allo may set it until
     * an enforcement mechanism actually exists.
     */
    expect(row?.enforcedAt).toBeNull();
  });

  it("does not act even in automatic mode, because there is nothing to act with", async () => {
    process.env.CROWDSOURCE_ENFORCEMENT_MODE = "automatic";
    resetCrowdSourceConfigForTests();
    await seedReport();

    await applyDecisionOutboxEvent(event(decision()));

    expect((await storedReport())?.enforcedAt).toBeNull();
    // Only the report row is touched. No block, no restrict, no user write.
    expect(await getDb().select().from(schema.blocks)).toHaveLength(0);
    expect(await getDb().select().from(schema.restricts)).toHaveLength(0);
  });

  it("ignores a revision that is not newer than the one already stored", async () => {
    /**
     * §10.6 allows redelivery and reordering, so an older revision arriving late
     * must never overwrite a newer one. Compared against what is STORED, not
     * against arrival order.
     */
    await seedReport({ decisionRevision: 5 });

    await applyDecisionOutboxEvent(event(decision({ revision: 3 })));
    expect((await storedReport())?.decisionRevision).toBe(5);
    expect((await storedReport())?.decisionOutcome).toBeNull();

    await applyDecisionOutboxEvent(event(decision({ revision: 5 })));
    expect((await storedReport())?.decisionRevision).toBe(5);
    expect((await storedReport())?.decisionOutcome).toBeNull();
  });

  it("applies a strictly newer revision", async () => {
    await seedReport({ decisionRevision: 5 });
    await applyDecisionOutboxEvent(event(decision({ revision: 6 })));
    expect((await storedReport())?.decisionRevision).toBe(6);
  });

  it("applies the FIRST decision, whose stored revision is NULL", async () => {
    /**
     * The case an `=` comparison drops in silence, and the reason the repository
     * compares with `is not distinct from`: `decision_revision = NULL` is NULL, so
     * an equality guard matches no row — and most reports have never been decided,
     * which makes this the common path rather than an edge one. Only a real server
     * can tell the two spellings apart.
     */
    await seedReport();
    await applyDecisionOutboxEvent(event(decision({ revision: 2 })));
    expect((await storedReport())?.decisionRevision).toBe(2);
  });

  it("retries — never dead-letters — a decision it cannot parse", async () => {
    /**
     * A payload this deployment cannot parse is far more likely to be a newer
     * CrowdSource than a corrupt one. The outbox keeps a retryable failure for
     * days, which is long enough to ship a contracts bump and let the backlog
     * apply itself; dead-lettering would discard a real decision because this
     * deployment was behind.
     */
    await seedReport();
    const thrown = await applyDecisionOutboxEvent(event({ nonsense: true })).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toHaveProperty("retryable", false);
    expect((await storedReport())?.decisionOutcome).toBeNull();
  });

  it("is a no-op when no local report matches the case", async () => {
    // A merged case (§7.3) can name a case another report opened. Nothing to apply.
    await expect(applyDecisionOutboxEvent(event(decision()))).resolves.toBeUndefined();
    expect(await getDb().select().from(schema.reports)).toHaveLength(0);
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
    expect(legacyStatusForOutcome("violation")).toBe("resolved");
    expect(legacyStatusForOutcome("no_violation")).toBe("dismissed");
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
      expect(legacyStatusForOutcome(outcome)).toBe("reviewed");
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
