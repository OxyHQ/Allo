import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportCategory, ReportedType } from "../../../models/Report";
import {
  loadCrowdSourceConfig,
  resetCrowdSourceConfigForTests,
} from "../../../config/crowdsource";
import {
  REPORT_TAXONOMY_VERSION,
  allegationsForCategories,
} from "../../../services/moderation/reportTaxonomy";

vi.mock("../../../services/moderation/subjects/registry", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/moderation/subjects/registry")
  >("../../../services/moderation/subjects/registry");
  return { ...actual, subjectProviderFor: vi.fn() };
});

import { resetBridgesConfigForTests } from "../../../config/bridges";
import {
  ModerationSubjectNotAnOxyAccountError,
  ModerationSubjectUnsupportedError,
  buildModerationReportInput,
  snapshotHash,
} from "../../../services/moderation/EvidenceSnapshotService";
import { subjectProviderFor } from "../../../services/moderation/subjects/registry";

describe("allegation mapping", () => {
  it("produces a stable ORDER for the same categories in any input order", () => {
    /**
     * Not cosmetic. Ingress fingerprints the whole envelope to detect §10.5's
     * "same external id, different body", so a list whose order followed however a
     * client happened to send its categories would turn a legitimate outbox retry
     * into a permanent 409 — days later, as a report silently stuck in a queue.
     */
    const forward = allegationsForCategories([
      ReportCategory.SPAM,
      ReportCategory.HARASSMENT,
      ReportCategory.HATE_SPEECH,
    ]);
    const reversed = allegationsForCategories([
      ReportCategory.HATE_SPEECH,
      ReportCategory.HARASSMENT,
      ReportCategory.SPAM,
    ]);
    expect(forward).toEqual(reversed);
    expect(forward).toEqual([...forward].sort());
  });

  it("deduplicates codes that share a mapping", () => {
    const codes = allegationsForCategories([ReportCategory.OTHER, ReportCategory.OTHER]);
    expect(codes).toEqual(["other.unclassifiable"]);
  });

  it("maps every category to a real taxonomy code", () => {
    /** The vacuity floor: a mapping that silently returned nothing is not a report. */
    for (const category of Object.values(ReportCategory)) {
      const codes = allegationsForCategories([category]);
      expect(codes).toHaveLength(1);
      expect(codes[0]).toMatch(/^[a-z_]+\.[a-z_]+$/);
    }
  });

  it("does not claim an integrity allegation for misinformation", () => {
    /**
     * A reporter clicking "misinformation" is not alleging organised manipulation
     * or intent to defraud. Forcing it into `integrity.*` would tell a jury the
     * reporter alleged something they did not.
     */
    expect(allegationsForCategories([ReportCategory.MISINFORMATION])).toEqual([
      "other.policy_specific",
    ]);
  });
});

describe("report envelope input", () => {
  const report = {
    id: "report-1",
    reportedType: ReportedType.USER,
    reportedId: "user-1",
    reporter: "reporter-1",
    categories: [ReportCategory.HARASSMENT, ReportCategory.SPAM],
    details: "  they keep messaging me  ",
    createdAt: new Date("2026-07-30T10:00:00.000Z"),
  } as unknown as Parameters<typeof buildModerationReportInput>[0];

  const snapshot = {
    subject: {
      externalId: "user-1",
      type: "identity.profile",
      author: { oxyUserId: "user-1" },
    },
    content: { type: "profile" as const, data: { displayName: "Someone" } },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(subjectProviderFor).mockReturnValue({
      reportedType: ReportedType.USER,
      subjectType: "identity.profile",
      snapshot: async () => snapshot,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the report's own timestamp, not the moment of delivery", async () => {
    /**
     * A value invented per attempt would make every outbox retry a permanent 409
     * (§10.5), because the envelope bytes would differ each time.
     */
    const built = await buildModerationReportInput(report);
    expect(built?.reportInput.submittedAt).toEqual(new Date("2026-07-30T10:00:00.000Z"));
    expect(built?.reportInput.externalReportId).toBe("report-1");
  });

  it("attaches the reporter's words to the FIRST allegation only", async () => {
    /**
     * §6.2: details are the reporter's claim, never evidence for it. Repeating one
     * free-text field across every code would say the reporter wrote it about each
     * of them separately.
     */
    const built = await buildModerationReportInput(report);
    const allegations = built?.reportInput.allegations ?? [];

    expect(allegations.length).toBeGreaterThan(1);
    expect(allegations[0]).toHaveProperty("details", "they keep messaging me");
    for (const allegation of allegations.slice(1)) {
      expect(allegation).not.toHaveProperty("details");
    }
  });

  it("declares that no evidence attachments will ever accompany an Allo case", async () => {
    /**
     * Not "not implemented yet". Allo is end-to-end encrypted, so a jury will never
     * receive conversation material from this application. Telling them so lets
     * `insufficient_context` be answered for the right reason instead of being read
     * as evidence withheld or lost.
     */
    const built = await buildModerationReportInput(report);
    expect(built?.reportInput.metadata).toMatchObject({
      evidenceAttachmentsSupported: false,
      alloTaxonomyVersion: REPORT_TAXONOMY_VERSION,
    });
  });

  it("binds the reporter by Oxy id and carries no other principal", async () => {
    const built = await buildModerationReportInput(report);
    expect(built?.reportInput.reportedBy).toEqual({ oxyUserId: "reporter-1" });
  });

  it("returns null when the account is gone", async () => {
    vi.mocked(subjectProviderFor).mockReturnValue({
      reportedType: ReportedType.USER,
      subjectType: "identity.profile",
      snapshot: async () => null,
    });
    await expect(buildModerationReportInput(report)).resolves.toBeNull();
  });

  it("throws a non-retryable error when the type has no provider", async () => {
    /**
     * Unreachable by design — such a report never gets a delivery event — so an
     * event that arrives here is a DEFECT. `retryable: false` dead-letters it where
     * a human will look, rather than filing it among the deliberate local-only
     * reports, which in Allo is where every reported message already sits.
     */
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);
    const thrown = await buildModerationReportInput(report).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ModerationSubjectUnsupportedError);
    expect(thrown).toHaveProperty("retryable", false);
  });

  /**
   * §6.5 — the last gate before material crosses the process boundary.
   *
   * Intake never queues one of these, so every assertion below is about a state
   * that should be unreachable. They are here because of what the reachable version
   * would DO rather than how likely it is: an event id composed into an envelope
   * and posted is a disclosure, not a stall, and it is not recoverable by fixing
   * the bug afterwards.
   */
  describe("a subject that is not an Oxy account", () => {
    beforeEach(() => {
      process.env.ALLO_MATRIX_SERVER_NAME = "allo.you";
      resetBridgesConfigForTests();
    });

    afterEach(() => {
      delete process.env.ALLO_MATRIX_SERVER_NAME;
      resetBridgesConfigForTests();
    });

    async function buildFor(reportedId: string): Promise<unknown> {
      return await buildModerationReportInput({ ...report, reportedId }).catch(
        (error: unknown) => error,
      );
    }

    it.each([
      ["a Matrix event id", "$eventid123:allo.you"],
      ["a room id", "!roomid123:allo.you"],
      ["a bridge ghost", "@whatsapp_1234567890:allo.you"],
      ["a federated user", "@someone:elsewhere.example"],
    ])("refuses to describe %s", async (_label, reportedId) => {
      const thrown = await buildFor(reportedId);

      expect(thrown).toBeInstanceOf(ModerationSubjectNotAnOxyAccountError);
      expect(thrown).toHaveProperty("retryable", false);
    });

    it("never calls the provider at all", async () => {
      /**
       * Refused BEFORE the description is built, not filtered after. A provider
       * that had already run would have made the read, and for a subject type that
       * one day describes something richer than a profile it would have composed
       * the material too — leaving only a promise that nobody serialises it.
       */
      const snapshotFn = vi.fn().mockResolvedValue(snapshot);
      vi.mocked(subjectProviderFor).mockReturnValue({
        reportedType: ReportedType.USER,
        subjectType: "identity.profile",
        snapshot: snapshotFn,
      });

      await buildFor("$eventid123:allo.you");
      expect(snapshotFn).not.toHaveBeenCalled();
    });

    it("keeps the identifier out of the error message", async () => {
      /**
       * The message travels: `ModerationDeliveryWorker` copies a thrown message
       * into `Report.lastDeliveryError` and the logger prints it. An event id
       * interpolated here would put conversation metadata into both — the exact
       * material §6.5 says does not leave, leaking through the error path of the
       * check that exists to stop it.
       */
      const eventId = "$aVeryDistinctiveEventId:allo.you";
      const thrown = await buildFor(eventId);

      expect(thrown).toBeInstanceOf(Error);
      if (thrown instanceof Error) {
        expect(thrown.message).not.toContain(eventId);
        expect(thrown.message).not.toContain("aVeryDistinctiveEventId");
        expect(thrown.message).toContain("report-1");
      }
    });

    it("still describes an MXID this homeserver owns", async () => {
      /**
       * The counterpart, and the one that would make this guard a regression if it
       * were missing: a local user reported from a room arrives as an MXID, and it
       * must resolve and deliver like any other account report.
       */
      const snapshotFn = vi.fn().mockResolvedValue(snapshot);
      vi.mocked(subjectProviderFor).mockReturnValue({
        reportedType: ReportedType.USER,
        subjectType: "identity.profile",
        snapshot: snapshotFn,
      });

      const built = await buildModerationReportInput({
        ...report,
        reportedId: "@user-1:allo.you",
      });

      expect(built).not.toBeNull();
      /**
       * The provider is handed the OXY id, never the MXID. It passes `reportedId`
       * straight to `oxyClient.getUserById`, so an MXID reaching it would be a 404
       * and a report closed as "the account no longer exists".
       */
      expect(snapshotFn).toHaveBeenCalledWith("user-1");
    });
  });
});

describe("snapshot hash", () => {
  const base = {
    subject: {
      externalId: "user-1",
      type: "identity.profile",
      author: { oxyUserId: "user-1" },
    },
    content: { type: "profile" as const, data: { displayName: "Someone" } },
  };

  it("is stable for identical material", () => {
    expect(snapshotHash(base)).toBe(snapshotHash({ ...base }));
    expect(snapshotHash(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("changes when the material changes", () => {
    const edited = {
      ...base,
      content: { type: "profile" as const, data: { displayName: "Someone Else" } },
    };
    expect(snapshotHash(edited)).not.toBe(snapshotHash(base));
  });
});

describe("crowdsource configuration", () => {
  beforeEach(() => {
    resetCrowdSourceConfigForTests();
  });

  it("defaults to disabled and to observe mode", () => {
    const config = loadCrowdSourceConfig({});
    expect(config.enabled).toBe(false);
    expect(config.enforcementMode).toBe("observe");
  });

  it("requires both directions once enabled", () => {
    /**
     * A half-configured integration is worse than a disabled one: reports leave and
     * nothing can come back, or the reverse. Both gaps are invisible until somebody
     * asks why a case never returned.
     */
    expect(() =>
      loadCrowdSourceConfig({ CROWDSOURCE_ENABLED: "true" }),
    ).toThrow(/CROWDSOURCE_SERVICE_KEY/);

    expect(() =>
      loadCrowdSourceConfig({
        CROWDSOURCE_ENABLED: "true",
        CROWDSOURCE_SERVICE_KEY: "key",
      }),
    ).toThrow(/CROWDSOURCE_WEBHOOK_SECRET/);
  });

  it("rejects a webhook secret short enough to brute-force", () => {
    /**
     * This secret is the only thing between a forged request and a moderation
     * decision acting on Allo accounts. A short one passes every functional test.
     */
    expect(() =>
      loadCrowdSourceConfig({
        CROWDSOURCE_ENABLED: "true",
        CROWDSOURCE_SERVICE_KEY: "key",
        CROWDSOURCE_WEBHOOK_SECRET: "tooshort",
      }),
    ).toThrow();
  });

  it("accepts a fully configured environment", () => {
    const config = loadCrowdSourceConfig({
      CROWDSOURCE_ENABLED: "true",
      CROWDSOURCE_SERVICE_KEY: "key",
      CROWDSOURCE_WEBHOOK_SECRET: "a-secret-of-sufficient-length",
      CROWDSOURCE_BASE_URL: "https://crowdsource.oxy.so/",
    });
    expect(config.enabled).toBe(true);
    // Trailing slash normalised, so a base URL cannot produce a double slash.
    expect(config.baseUrl).toBe("https://crowdsource.oxy.so");
  });

  it("has no surface for an application id at all", () => {
    /**
     * `CROWDSOURCE_APP_ID` is the IDOR the tenancy model exists to prevent: the
     * applicationId comes off the service credential, and a variable holding one
     * could only agree with the credential by luck. Setting it must change nothing.
     */
    const config = loadCrowdSourceConfig({ CROWDSOURCE_APP_ID: "some-other-tenant" });
    expect(Object.keys(config)).not.toContain("applicationId");
    expect(JSON.stringify(config)).not.toContain("some-other-tenant");
  });

  it("rejects a base URL carrying a path, query or credentials", () => {
    for (const baseUrl of [
      "https://user:pass@crowdsource.oxy.so",
      "https://crowdsource.oxy.so/v1",
      "https://crowdsource.oxy.so?a=1",
      "ftp://crowdsource.oxy.so",
    ]) {
      expect(() => loadCrowdSourceConfig({ CROWDSOURCE_BASE_URL: baseUrl })).toThrow();
    }
  });
});
