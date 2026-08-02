import mongoose from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * §7.1 — a 201 means stored-and-will-retry, never "CrowdSource accepted it".
 *
 * The property under test is atomicity: the `Report` and its `ModerationOutbox`
 * event commit in ONE transaction, so neither of the two silent failure modes is
 * reachable. A report with no delivery event is a report nothing will ever send,
 * and nobody finds out until somebody asks why a case never opened; a delivery
 * event with no report is a worker looking up an id that was rolled back.
 *
 * Both are invisible at the moment they happen, which is why this is asserted on
 * the SESSION each write receives rather than on the end state. A test that only
 * checked "both rows exist" passes just as happily against two sequential writes
 * outside a transaction — and that is exactly the regression worth catching.
 *
 * The second property: a report whose type has no subject provider gets NO
 * delivery event. Not one that is skipped later — none. In Allo that is the
 * majority path, because a reported message can never be reviewed.
 */

vi.mock("../../../models/Report", async () => {
  const actual = await vi.importActual<typeof import("../../../models/Report")>(
    "../../../models/Report",
  );
  return {
    ...actual,
    default: { findOne: vi.fn(), create: vi.fn() },
  };
});

vi.mock("../../../models/ModerationOutbox", () => ({
  MODERATION_OUTBOX_RETENTION_SECONDS: 90 * 24 * 60 * 60,
  default: { updateOne: vi.fn() },
}));

/**
 * The registry is mocked so both branches of the delivery decision are exercised
 * deterministically. WHICH types actually have providers is pinned separately, in
 * `subjectProviders.test.ts` — asserting it here too would couple this file to
 * Allo's own nouns, and the property under test is about any application's.
 */
vi.mock("../../../services/moderation/subjects/registry", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/moderation/subjects/registry")
  >("../../../services/moderation/subjects/registry");
  return { ...actual, subjectProviderFor: vi.fn() };
});

import ModerationOutbox from "../../../models/ModerationOutbox";
import Report, { ReportCategory, ReportedType } from "../../../models/Report";
import { reportSubmitEventId } from "../../../services/moderation/ModerationOutboxService";
import {
  DuplicateReportError,
  createReport,
} from "../../../services/moderation/ReportIntakeService";
import { subjectProviderFor } from "../../../services/moderation/subjects/registry";

interface TransactionSpy {
  committed: boolean;
  aborted: unknown;
  ended: boolean;
  session: mongoose.ClientSession;
}

function stubSession(): TransactionSpy {
  const spy: TransactionSpy = {
    committed: false,
    aborted: undefined,
    ended: false,
    session: undefined as unknown as mongoose.ClientSession,
  };

  const session = {
    /**
     * Reports being INSIDE a transaction, because `enqueueModerationOutboxEvent`
     * refuses to write otherwise. The stub has to model that, or every test here
     * would fail on the guard rather than on the behaviour it targets.
     */
    inTransaction: () => true,
    withTransaction: vi.fn(async (operation: () => Promise<void>) => {
      try {
        await operation();
        spy.committed = true;
      } catch (error: unknown) {
        spy.aborted = error;
        throw error;
      }
    }),
    endSession: vi.fn(async () => {
      spy.ended = true;
    }),
  };

  spy.session = session as unknown as mongoose.ClientSession;
  return spy;
}

const REPORT_ID = new mongoose.Types.ObjectId();

function stubCreatedReport() {
  return [{ _id: REPORT_ID, createdAt: new Date() }];
}

describe("report intake durability", () => {
  let transaction: TransactionSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    transaction = stubSession();
    vi.spyOn(mongoose, "startSession").mockResolvedValue(transaction.session);

    vi.mocked(Report.findOne).mockReturnValue({
      session: () => ({ lean: async () => null }),
    } as unknown as ReturnType<typeof Report.findOne>);
    vi.mocked(Report.create).mockResolvedValue(
      stubCreatedReport() as unknown as Awaited<ReturnType<typeof Report.create>>,
    );
    vi.mocked(ModerationOutbox.updateOne).mockResolvedValue(
      {} as unknown as Awaited<ReturnType<typeof ModerationOutbox.updateOne>>,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the report and its outbox event with the SAME session", async () => {
    vi.mocked(subjectProviderFor).mockReturnValue({
      reportedType: ReportedType.USER,
      subjectType: "identity.profile",
      snapshot: async () => null,
    });

    const result = await createReport({
      reporter: "reporter-1",
      reportedType: ReportedType.USER,
      reportedId: "user-1",
      categories: [ReportCategory.HARASSMENT],
    });

    expect(transaction.committed).toBe(true);
    expect(transaction.ended).toBe(true);

    // The report insert carried the session...
    const createOptions = vi.mocked(Report.create).mock.calls[0]?.[1];
    expect(createOptions).toEqual({ session: transaction.session });

    // ...and so did the outbox write, and it is the SAME object.
    const outboxOptions = vi.mocked(ModerationOutbox.updateOne).mock.calls[0]?.[2];
    expect(outboxOptions).toMatchObject({ upsert: true, session: transaction.session });

    expect(result.outboxEventId).toBe(reportSubmitEventId(REPORT_ID.toString()));
  });

  it("queues the report at localStatus 'queued' when it is deliverable", async () => {
    vi.mocked(subjectProviderFor).mockReturnValue({
      reportedType: ReportedType.USER,
      subjectType: "identity.profile",
      snapshot: async () => null,
    });

    await createReport({
      reporter: "reporter-1",
      reportedType: ReportedType.USER,
      reportedId: "user-1",
      categories: [ReportCategory.SPAM],
    });

    const [documents] = vi.mocked(Report.create).mock.calls[0] ?? [];
    expect(documents?.[0]).toMatchObject({ localStatus: "queued" });
    expect(documents?.[0]).not.toHaveProperty("localStatusReason");
  });

  it("stores a type with no provider and enqueues NOTHING", async () => {
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);

    const result = await createReport({
      reporter: "reporter-1",
      reportedType: ReportedType.MESSAGE,
      reportedId: "message-1",
      categories: [ReportCategory.HARASSMENT],
    });

    expect(transaction.committed).toBe(true);
    expect(Report.create).toHaveBeenCalledTimes(1);
    // The whole claim: stored, and no delivery event exists at all.
    expect(ModerationOutbox.updateOne).not.toHaveBeenCalled();
    expect(result.outboxEventId).toBeUndefined();

    const [documents] = vi.mocked(Report.create).mock.calls[0] ?? [];
    expect(documents?.[0]).toMatchObject({ localStatus: "received" });
    // The reason is RECORDED, not inferred from the missing row: a missing row is
    // also what a lost write looks like.
    expect(documents?.[0]?.localStatusReason).toContain("end-to-end encrypted");
  });

  it("aborts the transaction when the outbox write fails", async () => {
    vi.mocked(subjectProviderFor).mockReturnValue({
      reportedType: ReportedType.USER,
      subjectType: "identity.profile",
      snapshot: async () => null,
    });
    vi.mocked(ModerationOutbox.updateOne).mockRejectedValue(new Error("outbox down"));

    await expect(
      createReport({
        reporter: "reporter-1",
        reportedType: ReportedType.USER,
        reportedId: "user-1",
        categories: [ReportCategory.SPAM],
      }),
    ).rejects.toThrow("outbox down");

    // Neither row survives: the report insert is rolled back with the outbox write.
    expect(transaction.committed).toBe(false);
    expect(transaction.aborted).toBeInstanceOf(Error);
    expect(transaction.ended).toBe(true);
  });

  it("refuses an identifier that is not a string, before building a query", async () => {
    /**
     * A truthiness check would pass `{$ne: null}` straight into `findOne`, which
     * matches an unrelated report and answers "you already reported this" about
     * somebody else's row. The guard lives in the service, not the route, because
     * `createReport` is exported and a future caller is under no obligation to
     * have passed the route's validation.
     */
    const injected = { $ne: null } as unknown as string;

    await expect(
      createReport({
        reporter: injected,
        reportedType: ReportedType.USER,
        reportedId: "user-1",
        categories: [ReportCategory.SPAM],
      }),
    ).rejects.toThrow(TypeError);

    expect(Report.findOne).not.toHaveBeenCalled();
    expect(Report.create).not.toHaveBeenCalled();
  });

  it("refuses an empty identifier", async () => {
    await expect(
      createReport({
        reporter: "   ",
        reportedType: ReportedType.USER,
        reportedId: "user-1",
        categories: [ReportCategory.SPAM],
      }),
    ).rejects.toThrow(/must not be empty/);
  });

  it("refuses a reportedType that is not a reportable type", async () => {
    await expect(
      createReport({
        reporter: "reporter-1",
        reportedType: "device_key" as ReportedType,
        reportedId: "device-1",
        categories: [ReportCategory.SPAM],
      }),
    ).rejects.toThrow(/is not a reportable type/);

    expect(Report.create).not.toHaveBeenCalled();
  });

  it("raises DuplicateReportError with the existing row", async () => {
    const existing = { _id: REPORT_ID, createdAt: new Date() };
    vi.mocked(Report.findOne).mockReturnValue({
      session: () => ({ lean: async () => existing }),
    } as unknown as ReturnType<typeof Report.findOne>);

    await expect(
      createReport({
        reporter: "reporter-1",
        reportedType: ReportedType.USER,
        reportedId: "user-1",
        categories: [ReportCategory.SPAM],
      }),
    ).rejects.toBeInstanceOf(DuplicateReportError);

    expect(Report.create).not.toHaveBeenCalled();
    expect(ModerationOutbox.updateOne).not.toHaveBeenCalled();
  });
});
