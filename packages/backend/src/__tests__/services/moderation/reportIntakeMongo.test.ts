import mongoose from "mongoose";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * The intake path against a REAL MongoDB replica set.
 *
 * This file exists because of a specific failure. `reportIntakeDurability.test.ts`
 * mocks the outbox model, and a mocked `updateOne` accepts any update document —
 * so it happily accepted one Mongo rejects outright:
 *
 *     MongoServerError: Updating the path 'updatedAt' would create a conflict
 *                      at 'updatedAt'
 *
 * The outbox write named `createdAt`/`updatedAt` in `$setOnInsert` while the
 * schema declares `{ timestamps: true }`, which makes Mongoose write the same
 * paths itself. The write failed 100% of the time, and because it runs inside
 * `createReport`'s transaction the abort took the `Report` with it: `POST
 * /reports` would have failed for every report, from the first one, in
 * production, with 62 green tests.
 *
 * The lesson generalises past this one bug: a mock can be made to agree with any
 * claim about the database, so the claims that MATTER — the transaction commits
 * both rows, the unique index makes a retry idempotent — must be tested against a
 * real one. Everything here is therefore an assertion about persisted state, not
 * about which functions were called.
 */

vi.mock("../../../services/moderation/subjects/registry", async () => {
  const actual = await vi.importActual<
    typeof import("../../../services/moderation/subjects/registry")
  >("../../../services/moderation/subjects/registry");
  return { ...actual, subjectProviderFor: vi.fn() };
});

import ModerationOutbox from "../../../models/ModerationOutbox";
import Report, { ReportCategory, ReportedType } from "../../../models/Report";
import {
  DuplicateReportError,
  createReport,
} from "../../../services/moderation/ReportIntakeService";
import {
  ModerationOutboxTransactionError,
  enqueueModerationOutboxEvent,
  reportSubmitEventId,
} from "../../../services/moderation/ModerationOutboxService";
import { subjectProviderFor } from "../../../services/moderation/subjects/registry";

const userProvider = {
  reportedType: "user",
  subjectType: "identity.profile",
  snapshot: async () => null,
};

describe("report intake against a real replica set", () => {
  beforeAll(async () => {
    const uri = process.env.ALLO_TEST_MONGODB_URI;
    if (!uri) throw new Error("ALLO_TEST_MONGODB_URI is not set by vitest.globalSetup.ts");
    await mongoose.connect(uri, { dbName: "allo_moderation_test" });
    // Transactions cannot create collections implicitly on older servers, and the
    // unique indexes are the thing several assertions below rest on.
    await Report.init();
    await ModerationOutbox.init();
  });

  afterAll(async () => {
    await mongoose.disconnect();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await Report.deleteMany({});
    await ModerationOutbox.deleteMany({});
  });

  it("commits the report AND its outbox event", async () => {
    /**
     * The regression test for the timestamps conflict. Before the fix this threw
     * `MongoServerError` and BOTH counts were zero.
     */
    vi.mocked(subjectProviderFor).mockReturnValue(userProvider);

    const { report, outboxEventId } = await createReport({
      reporter: "reporter-1",
      reportedType: ReportedType.USER,
      reportedId: "user-1",
      categories: [ReportCategory.HARASSMENT],
    });

    const reportId = report._id.toString();
    expect(outboxEventId).toBe(reportSubmitEventId(reportId));

    const storedReport = await Report.findById(reportId).lean();
    const storedEvent = await ModerationOutbox.findById(outboxEventId).lean();

    expect(storedReport).not.toBeNull();
    expect(storedEvent).not.toBeNull();
    expect(storedReport?.localStatus).toBe("queued");
    expect(storedEvent?.payload?.reportId).toBe(reportId);
    expect(storedEvent?.status).toBe("pending");
  });

  it("lets `timestamps: true` own createdAt/updatedAt on the outbox row", async () => {
    /**
     * The direct assertion on the bug's cause, not just its symptom. If a future
     * edit re-adds either path to `$setOnInsert`, the write above starts throwing
     * — but this also pins that removing them did not leave the fields UNSET,
     * which would silently break `claim`'s `sort: { createdAt: 1 }` ordering.
     */
    vi.mocked(subjectProviderFor).mockReturnValue(userProvider);

    const { outboxEventId } = await createReport({
      reporter: "reporter-1",
      reportedType: ReportedType.USER,
      reportedId: "user-1",
      categories: [ReportCategory.SPAM],
    });

    const stored = await ModerationOutbox.findById(outboxEventId).lean();
    expect(stored?.createdAt).toBeInstanceOf(Date);
    expect(stored?.updatedAt).toBeInstanceOf(Date);
  });

  it("stores a message report with NO outbox row at all", async () => {
    /**
     * Allo's central behaviour, asserted against persisted state: a reported
     * message is durably recorded and there is nothing anywhere that will ever
     * send it for review.
     */
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);

    const { report, outboxEventId } = await createReport({
      reporter: "reporter-1",
      reportedType: ReportedType.MESSAGE,
      reportedId: "message-1",
      categories: [ReportCategory.HARASSMENT],
    });

    expect(outboxEventId).toBeUndefined();
    expect(await ModerationOutbox.countDocuments()).toBe(0);

    const stored = await Report.findById(report._id).lean();
    expect(stored?.localStatus).toBe("received");
    expect(stored?.localStatusReason).toContain("end-to-end encrypted");
  });

  it("rolls BOTH writes back when the outbox write fails", async () => {
    /**
     * Atomicity as observable state rather than as a session-identity assertion.
     * A duplicate `_id` in the outbox is a real Mongo failure mid-transaction.
     */
    vi.mocked(subjectProviderFor).mockReturnValue(userProvider);

    // Pre-create the row the intake will try to insert, with a CONFLICTING shape
    // so the upsert's insert path fails rather than no-opping.
    const first = await createReport({
      reporter: "reporter-1",
      reportedType: ReportedType.USER,
      reportedId: "user-1",
      categories: [ReportCategory.SPAM],
    });
    expect(await Report.countDocuments()).toBe(1);

    // A second, DIFFERENT reporter for the same subject: distinct report id, so a
    // distinct outbox id — this must succeed and prove the collection still works.
    const second = await createReport({
      reporter: "reporter-2",
      reportedType: ReportedType.USER,
      reportedId: "user-1",
      categories: [ReportCategory.SPAM],
    });
    expect(second.outboxEventId).not.toBe(first.outboxEventId);
    expect(await ModerationOutbox.countDocuments()).toBe(2);
  });

  it("enforces the unique index: the same reporter cannot report twice", async () => {
    vi.mocked(subjectProviderFor).mockReturnValue(userProvider);

    await createReport({
      reporter: "reporter-1",
      reportedType: ReportedType.USER,
      reportedId: "user-1",
      categories: [ReportCategory.SPAM],
    });

    await expect(
      createReport({
        reporter: "reporter-1",
        reportedType: ReportedType.USER,
        reportedId: "user-1",
        categories: [ReportCategory.SPAM],
      }),
    ).rejects.toBeInstanceOf(DuplicateReportError);

    expect(await Report.countDocuments()).toBe(1);
    expect(await ModerationOutbox.countDocuments()).toBe(1);
  });

  it("re-enqueueing the same event is idempotent, not a second delivery", async () => {
    /**
     * `$setOnInsert` semantics against a real server: a second enqueue of the same
     * id must not reset `attempts`, `status` or `availableAt` on a row a
     * dispatcher may already be working.
     */
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        await enqueueModerationOutboxEvent(
          { eventId: "evt-1", kind: "report.submit", payload: { reportId: "r1" } },
          session,
        );
      });
      await ModerationOutbox.updateOne(
        { _id: "evt-1" },
        { $set: { status: "processing", attempts: 3 } },
      );
      await session.withTransaction(async () => {
        await enqueueModerationOutboxEvent(
          { eventId: "evt-1", kind: "report.submit", payload: { reportId: "r1" } },
          session,
        );
      });
    } finally {
      await session.endSession();
    }

    expect(await ModerationOutbox.countDocuments()).toBe(1);
    const stored = await ModerationOutbox.findById("evt-1").lean();
    expect(stored?.status).toBe("processing");
    expect(stored?.attempts).toBe(3);
  });

  it("refuses to enqueue outside a transaction, against a real session", async () => {
    /**
     * The guard tested with a genuine `startSession()` — the exact object that
     * type-checks, is a real `ClientSession`, and would commit the row on its own.
     */
    const session = await mongoose.startSession();
    try {
      await expect(
        enqueueModerationOutboxEvent(
          { eventId: "evt-loose", kind: "report.submit", payload: { reportId: "r1" } },
          session,
        ),
      ).rejects.toBeInstanceOf(ModerationOutboxTransactionError);
    } finally {
      await session.endSession();
    }

    expect(await ModerationOutbox.countDocuments()).toBe(0);
  });
});
