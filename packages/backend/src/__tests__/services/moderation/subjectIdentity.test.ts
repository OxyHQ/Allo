import { describe, expect, it } from "vitest";

import { MAX_REPORT_LOCAL_STATUS_REASON_LENGTH } from "../../../db/schema/moderation";
import {
  moderationSubjectReasons,
  resolveModerationSubject,
} from "../../../services/moderation/subjectIdentity";

/**
 * Which reported identifiers name an Oxy account, and which only look like one.
 *
 * The decision under test is about a SILENCE. A report about an identifier with
 * no account behind it produces a 404 from Oxy, which the provider correctly
 * reads as "no such account", which the delivery worker correctly reads as "the
 * account was deleted" — and the report closes saying something that was never
 * true. Nothing fails. Nothing logs. The reporter gets a 201 and a row that tells
 * a plausible lie.
 *
 * So the assertions below are mostly about the SENTENCE on the row, not about a
 * boolean. A test that only checked `kind` would pass against a version that
 * classified correctly and then recorded nothing, which is the same silence with a
 * better-typed hole in the middle.
 */

const OXY_ID = "507f1f77bcf86cd799439011";

describe("resolving a reported identifier", () => {
  it("passes an Oxy account id through untouched", () => {
    /**
     * Every report the app files. `Report.reportedId` is an Oxy id, so the id
     * has to come out of this function exactly as it went in — if it did not,
     * the dedup key `{reporter, reportedId, reportedType}` would have moved.
     */
    expect(resolveModerationSubject(OXY_ID)).toEqual({
      kind: "oxy-account",
      reportedId: OXY_ID,
    });
  });

  it("trims, so the same account spelled with whitespace is one subject", () => {
    expect(resolveModerationSubject(`  ${OXY_ID}  `).reportedId).toBe(OXY_ID);
  });

  it("records a handle as not reviewable rather than guessing who holds it", () => {
    /**
     * A handle names whoever displays it today. Resolving it at intake would file
     * the report against the holder at that instant, and delivering it later
     * would describe whoever holds it then — two people, one row. The row says
     * so, so an operator reading it knows the client sent a name and not an id.
     */
    const resolved = resolveModerationSubject("@someone");

    expect(resolved.kind).toBe("not-an-oxy-account");
    expect(resolved).toHaveProperty("reason", expect.stringContaining("handle"));
  });

  it("keeps a handle as given, because there is no id to canonicalise it to", () => {
    expect(resolveModerationSubject("@someone").reportedId).toBe("@someone");
  });

  it("never echoes the identifier back into the reason", () => {
    /**
     * `localStatus` reasons are the field an operator reads in bulk. A reason
     * that interpolated the identifier would copy a name into a second column,
     * and the reasons are meant to be a closed set of sentences.
     */
    const resolved = resolveModerationSubject("@aVeryDistinctiveHandle");

    expect(resolved).toHaveProperty("reason");
    if (resolved.kind === "not-an-oxy-account") {
      expect(resolved.reason).not.toContain("aVeryDistinctiveHandle");
    }
  });
});

describe("the reasons written onto a report", () => {
  /**
   * `reports.local_status_reason` is bounded by a CHECK, and intake writes the
   * reason INSIDE the transaction that stores the report. `reportRepository`
   * truncates to the same bound, so an over-long reason is not a 500 — it is a
   * sentence that stops making sense halfway through, in the one place an
   * operator reads to find out why a report never left. Quieter, and therefore
   * worth a test rather than less.
   *
   * The bound is read from the constant the CHECK and the truncation are both
   * rendered from, so there is one number here, not a third copy of it.
   */
  it("every reason fits the field it is stored in", () => {
    const limit = MAX_REPORT_LOCAL_STATUS_REASON_LENGTH;
    expect(moderationSubjectReasons().length).toBeGreaterThan(0);
    for (const reason of moderationSubjectReasons()) {
      expect(reason.length).toBeLessThanOrEqual(limit);
    }
  });

  it("says what CrowdSource does, in every reason", () => {
    for (const reason of moderationSubjectReasons()) {
      expect(reason).toContain("CrowdSource reviews Oxy accounts only");
      expect(reason).toContain("not sent for community review");
    }
  });
});
