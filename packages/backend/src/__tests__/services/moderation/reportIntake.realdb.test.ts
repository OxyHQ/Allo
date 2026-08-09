import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The intake path against a REAL Postgres server.
 *
 * This replaces two files — `reportIntakeMongo.test.ts`, which ran against a real
 * replica set, and `reportIntakeDurability.test.ts`, which mocked the models — and
 * it keeps every case from both. The merge is not tidying: after the port there is
 * no longer a mock-shaped version of these claims to write. `createReport` takes a
 * drizzle transaction handle rather than a `ClientSession`, and the assertions that
 * used to be about WHICH session each write received are the ones a real server
 * answers directly, by whether the rows are there.
 *
 * The reason the real server is not optional is the bug that put the Mongo file
 * here: a mocked `updateOne` accepted an update document Mongo rejected outright,
 * so `POST /reports` would have failed for every report ever submitted, in
 * production, with 62 green tests. A mock can be made to agree with any claim
 * about the database, so the claims that MATTER — both rows commit together, the
 * unique index makes a retry idempotent, a failed second write takes the first
 * with it — must be tested against a real one.
 *
 * Everything here is therefore an assertion about persisted state, with two
 * deliberate exceptions, both of them spies on things that are NOT the database:
 * the subject registry (so both branches of the delivery decision are exercised
 * without coupling this file to Allo's own nouns) and `bridgesConfig` (so the
 * ORDER of two decisions inside `routeReport` can be pinned from outside).
 */

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

/**
 * Wrapped rather than replaced: the real implementation still runs, and the spy is
 * only here so one test can assert that a reported MESSAGE never asks the bridge
 * configuration anything. That is not a performance assertion — it is how the
 * ordering inside `routeReport` is pinned from the outside.
 */
/**
 * Real by default, and overridable in exactly one case.
 *
 * `enqueueModerationOutboxEvent` runs for real everywhere here — it is half of
 * the atomicity under test. The one case that needs it to FAIL replaces it for
 * the duration, because a durable second write that fails on demand has no
 * natural trigger: the enqueue converges on conflict by design.
 */
vi.mock("../../../db/moderation/moderationOutboxRepository", async () => {
  const actual = await vi.importActual<
    typeof import("../../../db/moderation/moderationOutboxRepository")
  >("../../../db/moderation/moderationOutboxRepository");
  return { ...actual, enqueueModerationOutboxEvent: vi.fn(actual.enqueueModerationOutboxEvent) };
});

vi.mock("../../../config/bridges", async () => {
  const actual = await vi.importActual<typeof import("../../../config/bridges")>(
    "../../../config/bridges",
  );
  return { ...actual, bridgesConfig: vi.fn(actual.bridgesConfig) };
});

import { bridgesConfig, resetBridgesConfigForTests } from "../../../config/bridges";
import { enqueueModerationOutboxEvent } from "../../../db/moderation/moderationOutboxRepository";
import { closePostgres, connectPostgres, getDb } from "../../../db";
import * as schema from "../../../db/schema";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../../db/testDatabase";
import type { ReportedType } from "../../../db/schema/moderation";
import { reportSubmitEventId } from "../../../services/moderation/ModerationOutboxService";
import {
  DuplicateReportError,
  createReport,
} from "../../../services/moderation/ReportIntakeService";
import { MAX_REPORTED_IDENTIFIER_BYTES } from "../../../services/moderation/subjectIdentity";
import { subjectProviderFor } from "../../../services/moderation/subjects/registry";
import type { ModerationSubjectProvider } from "../../../services/moderation/subjects/types";

const userProvider: ModerationSubjectProvider = {
  reportedType: "user",
  subjectType: "identity.profile",
  snapshot: async () => null,
};

let handle: TestDatabaseHandle;

/** Unique per call so cases cannot collide inside the one shared database. */
let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${String(counter).padStart(4, "0")}`;
}

async function storedReports() {
  return await getDb().select().from(schema.reports);
}

async function storedOutbox() {
  return await getDb().select().from(schema.moderationOutbox);
}

beforeAll(async () => {
  handle = await setUpTestDatabase();
  connectPostgres(handle.databaseUrl);
}, 180_000);

afterAll(async () => {
  await closePostgres();
  await handle?.drop();
});

beforeEach(() => {
  vi.mocked(subjectProviderFor).mockReturnValue(userProvider);
});

afterEach(async () => {
  vi.clearAllMocks();
  await getDb().delete(schema.moderationOutbox);
  await getDb().delete(schema.reports);
});

describe("report intake durability", () => {
  it("commits the report AND its outbox event", async () => {
    const reporter = id("reporter");
    const { report, outboxEventId } = await createReport({
      reporter,
      reportedType: "user",
      reportedId: id("user"),
      categories: ["harassment"],
    });

    expect(outboxEventId).toBe(reportSubmitEventId(report.id));

    const reports = await storedReports();
    const outbox = await storedOutbox();
    expect(reports).toHaveLength(1);
    expect(outbox).toHaveLength(1);
    expect(reports[0]?.localStatus).toBe("queued");
    expect(reports[0]?.localStatusReason).toBeNull();
    expect(outbox[0]?.id).toBe(outboxEventId);
    expect(outbox[0]?.payloadReportId).toBe(report.id);
    expect(outbox[0]?.status).toBe("pending");
  });

  it("stores a type with no provider and enqueues NOTHING", async () => {
    /**
     * Allo's central behaviour, asserted against persisted state: a reported
     * message is durably recorded and there is nothing anywhere that will ever
     * send it for review.
     */
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);

    const { outboxEventId } = await createReport({
      reporter: id("reporter"),
      reportedType: "message",
      reportedId: id("message"),
      categories: ["harassment"],
    });

    expect(outboxEventId).toBeUndefined();
    expect(await storedOutbox()).toHaveLength(0);

    const reports = await storedReports();
    expect(reports[0]?.localStatus).toBe("received");
    // The reason is RECORDED, not inferred from the missing row: a missing row is
    // also what a lost write looks like.
    expect(reports[0]?.localStatusReason).toContain("end-to-end encrypted");
  });

  it("rolls the report back when the outbox write fails", async () => {
    /**
     * Atomicity as observable state. The failure is INJECTED — a durable second
     * write that fails on demand has no natural trigger here, since
     * `enqueueModerationOutboxEvent` converges on conflict by design — but what is
     * asserted afterwards is entirely real: the server rolled the report insert
     * back, and there is no row.
     *
     * Both silent failure modes live on this line. A report with no delivery event
     * is a report nothing will ever send, and nobody finds out until somebody asks
     * why a case never opened.
     */
    vi.mocked(enqueueModerationOutboxEvent).mockRejectedValueOnce(new Error("outbox down"));

    await expect(
      createReport({
        reporter: id("reporter"),
        reportedType: "user",
        reportedId: id("user"),
        categories: ["spam"],
      }),
    ).rejects.toThrow("outbox down");

    expect(await storedReports()).toHaveLength(0);
    expect(await storedOutbox()).toHaveLength(0);
  });

  it("enforces the unique index: the same reporter cannot report twice", async () => {
    const subject = { reporter: id("reporter"), reportedType: "user" as ReportedType, reportedId: id("user") };

    await createReport({ ...subject, categories: ["spam"] });

    await expect(createReport({ ...subject, categories: ["spam"] })).rejects.toBeInstanceOf(
      DuplicateReportError,
    );

    expect(await storedReports()).toHaveLength(1);
    expect(await storedOutbox()).toHaveLength(1);
  });

  it("answers a CONCURRENT duplicate from outside the aborted transaction", async () => {
    /**
     * The case the pre-read cannot close, and the one that would have been a 500.
     *
     * `findReportBySubject` and the insert are two statements, so two concurrent
     * first submissions both see nothing and both insert;
     * `reports_reporter_reported_id_reported_type_key` decides the winner and the
     * loser gets a `23505`.
     *
     * In Postgres a failed statement aborts the WHOLE transaction, so the recovery
     * read that turns that into "you have already reported this" CANNOT happen
     * inside it — it would come back as `25P02 current transaction is aborted`,
     * and the reporter would get a 500 telling them their report was not filed
     * when the winner's copy is on file. Moving the read outside the transaction is
     * what this case pins, and moving it back in is what makes it fail.
     *
     * Mongo needed none of this: a duplicate-key error there left the session
     * usable, so the natural recovery shape ported straight across and was wrong.
     */
    const subject = { reporter: id("reporter"), reportedType: "user" as ReportedType, reportedId: id("user") };

    /**
     * postgres.js opens connections on demand, so the FIRST concurrent burst after
     * a run of sequential queries queues onto one connection and executes strictly
     * in order — a racing case in that position silently tests nothing.
     */
    await Promise.all(Array.from({ length: 8 }, () => storedReports()));

    const outcomes = await Promise.allSettled([
      createReport({ ...subject, categories: ["spam"] }),
      createReport({ ...subject, categories: ["spam"] }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const failure = rejected[0];
    // Named explicitly: a `25P02` would also be a rejection, and reading "one of
    // them failed" as a pass is exactly how the aborted-transaction bug survives.
    expect(failure?.status === "rejected" && failure.reason).toBeInstanceOf(DuplicateReportError);

    const reports = await storedReports();
    expect(reports).toHaveLength(1);
    // The loser is told about the row that IS on file, not about its own.
    const duplicate = failure?.status === "rejected" ? failure.reason : null;
    expect(duplicate instanceof DuplicateReportError && duplicate.existing.id).toBe(reports[0]?.id);
  });

  it("raises DuplicateReportError with the existing row", async () => {
    const subject = { reporter: id("reporter"), reportedType: "user" as ReportedType, reportedId: id("user") };
    const first = await createReport({ ...subject, categories: ["spam"] });

    const error = await createReport({ ...subject, categories: ["spam"] }).then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DuplicateReportError);
    expect((error as DuplicateReportError).existing.id).toBe(first.report.id);
  });
});

/**
 * §6.3 — the second way a report can have nowhere to go.
 *
 * Everything above is about a TYPE with no provider. These are about a SUBJECT
 * with no Oxy account, which is a different fact and, before this, an invisible
 * one: the type is deliverable, the provider exists, the report queues, and hours
 * later Oxy answers 404 and the delivery worker closes the report saying "the
 * reported account no longer exists" — about an account that never existed.
 *
 * The registry returns a provider throughout, because that is the whole point:
 * this branch must fire even when everything about the TYPE is fine.
 */
describe("a subject that is not an Oxy account", () => {
  const SERVER_NAME = "allo.you";

  beforeEach(() => {
    process.env.ALLO_MATRIX_SERVER_NAME = SERVER_NAME;
    resetBridgesConfigForTests();
  });

  afterEach(() => {
    delete process.env.ALLO_MATRIX_SERVER_NAME;
    resetBridgesConfigForTests();
  });

  it("stores a bridge ghost with a reason and enqueues NOTHING", async () => {
    const { outboxEventId } = await createReport({
      reporter: id("reporter"),
      reportedType: "user",
      reportedId: `@whatsapp_1234567890:${SERVER_NAME}`,
      categories: ["harassment"],
    });

    expect(outboxEventId).toBeUndefined();
    expect(await storedOutbox()).toHaveLength(0);

    const reports = await storedReports();
    expect(reports[0]?.localStatus).toBe("received");
    expect(reports[0]?.localStatusReason).toContain("WhatsApp");
  });

  it("gives the non-Oxy subject its OWN reason, not the encryption one", async () => {
    /**
     * The two reasons must stay distinguishable months later. "Allo cannot read
     * messages" and "this subject has no Oxy account" are different claims with
     * different remedies, and collapsing them would put a bridge ghost in the same
     * bucket as every reported message — the bucket nobody investigates because in
     * Allo it is where most reports live.
     */
    await createReport({
      reporter: id("reporter"),
      reportedType: "user",
      reportedId: "@someone:elsewhere.example",
      categories: ["spam"],
    });

    const reason = (await storedReports())[0]?.localStatusReason;
    expect(reason).toContain("homeserver");
    expect(reason).not.toContain("end-to-end encrypted");
  });

  it("stores an MXID this homeserver owns as the OXY id", async () => {
    /**
     * §6.2. The stored key is the Oxy id whichever identifier the client had, so
     * the unique index sees one subject and §7.3 opens one case. Storing the MXID
     * would let one reporter file twice about one person.
     */
    const oxyId = "507f1f77bcf86cd799439011";

    const { report, outboxEventId } = await createReport({
      reporter: id("reporter"),
      reportedType: "user",
      reportedId: `@${oxyId}:${SERVER_NAME}`,
      categories: ["spam"],
    });

    const reports = await storedReports();
    expect(reports[0]?.reportedId).toBe(oxyId);
    expect(reports[0]?.localStatus).toBe("queued");
    expect(outboxEventId).toBe(reportSubmitEventId(report.id));
  });

  it("looks up the duplicate under the canonical id too", async () => {
    /**
     * The dedup read is built from the same resolved id as the insert. If it were
     * not, reporting `@507f…:allo.you` after `507f…` would miss the existing row —
     * and the unique index would then reject the insert, which now surfaces as a
     * duplicate anyway. So the assertion is the STORED count: one report, however
     * the second submission spelled its subject.
     */
    const oxyId = "507f1f77bcf86cd799439011";
    const reporter = id("reporter");

    await createReport({
      reporter,
      reportedType: "user",
      reportedId: oxyId,
      categories: ["spam"],
    });

    await expect(
      createReport({
        reporter,
        reportedType: "user",
        reportedId: `@${oxyId}:${SERVER_NAME}`,
        categories: ["spam"],
      }),
    ).rejects.toBeInstanceOf(DuplicateReportError);

    expect(await storedReports()).toHaveLength(1);
  });

  it("never queues a Matrix event id for delivery", async () => {
    /**
     * §6.5. An event id names one message in one room; it is conversation metadata
     * and it must never reach CrowdSource. Reported as a `user` — which is the
     * shape a mistake takes, not an attack — the type check alone would wave it
     * through, so the SUBJECT check is what stops it.
     */
    const { outboxEventId } = await createReport({
      reporter: id("reporter"),
      reportedType: "user",
      reportedId: "$eventid123:allo.you",
      categories: ["harassment"],
    });

    expect(outboxEventId).toBeUndefined();
    expect(await storedOutbox()).toHaveLength(0);
    expect((await storedReports())[0]?.localStatusReason).toContain("conversation metadata");
  });
});

/**
 * The order in which intake decides, pinned from the outside.
 *
 * "This TYPE never leaves" outranks "this SUBJECT has no Oxy account", and the
 * ordering has to live in the control flow rather than only in the reason that
 * comes back. When it did not, resolving ran for every reported type, and a
 * `message` report whose id began with `@` and matched this homeserver came out
 * with its `reportedId` rewritten to the MXID's localpart — a string shaped like
 * an Oxy user id, stored as the identity of a reported message, where an
 * MXID → Oxy translation means nothing whatsoever.
 */
describe("a type with no provider is decided before the subject is resolved", () => {
  const SERVER_NAME = "allo.you";

  beforeEach(() => {
    process.env.ALLO_MATRIX_SERVER_NAME = SERVER_NAME;
    resetBridgesConfigForTests();
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);
  });

  afterEach(() => {
    delete process.env.ALLO_MATRIX_SERVER_NAME;
    resetBridgesConfigForTests();
  });

  it("stores an MXID-shaped message id verbatim, never as a localpart", async () => {
    const messageId = `@${"a".repeat(24)}:${SERVER_NAME}`;

    await createReport({
      reporter: id("reporter"),
      reportedType: "message",
      reportedId: messageId,
      categories: ["harassment"],
    });

    expect((await storedReports())[0]?.reportedId).toBe(messageId);
  });

  it("does not consult the bridge configuration at all", async () => {
    /**
     * The other half of the same defect, and the one a value assertion cannot see:
     * every reported message was parsing bridge configuration to compute an answer
     * that was then discarded.
     */
    await createReport({
      reporter: id("reporter"),
      reportedType: "message",
      reportedId: `@${"a".repeat(24)}:${SERVER_NAME}`,
      categories: ["harassment"],
    });

    expect(bridgesConfig).not.toHaveBeenCalled();
  });

  it("still records the type's own reason, not a subject one", async () => {
    await createReport({
      reporter: id("reporter"),
      reportedType: "message",
      reportedId: "@someone:elsewhere.example",
      categories: ["harassment"],
    });

    const reason = (await storedReports())[0]?.localStatusReason;
    expect(reason).toContain("end-to-end encrypted");
    expect(reason).not.toContain("homeserver");
  });
});

/**
 * §6.3 turns "we could not resolve it" into "we store it and say why", which is
 * the right answer and also the reason an unbounded identifier is reachable at
 * all: untrusted bytes are persisted by design. What that costs is not a rejected
 * insert — a `text` column takes a megabyte without complaint — it is a `user`
 * report whose delivery event calls `getUserById` with a megabyte in the URL path
 * and fails with something `isOxyUserNotFound` does not recognise, so the outbox
 * retries it as an outage for ever.
 */
describe("the bound on a reported identifier", () => {
  it("refuses an identifier longer than the Matrix ceiling", async () => {
    await expect(
      createReport({
        reporter: id("reporter"),
        reportedType: "user",
        reportedId: "a".repeat(MAX_REPORTED_IDENTIFIER_BYTES + 1),
        categories: ["spam"],
      }),
    ).rejects.toThrow(TypeError);

    expect(await storedReports()).toHaveLength(0);
  });

  it("accepts one of exactly the ceiling, so the bound is not off by one", async () => {
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);

    await createReport({
      reporter: id("reporter"),
      reportedType: "message",
      reportedId: "a".repeat(MAX_REPORTED_IDENTIFIER_BYTES),
      categories: ["spam"],
    });

    expect(await storedReports()).toHaveLength(1);
  });

  it("counts BYTES, not characters", async () => {
    /**
     * The limits that eventually bite — a URL, a header, an index key — are byte
     * limits. 200 characters of Cyrillic is 400 bytes, and a character-counted
     * bound would wave it through.
     */
    await expect(
      createReport({
        reporter: id("reporter"),
        reportedType: "user",
        reportedId: "д".repeat(200),
        categories: ["spam"],
      }),
    ).rejects.toThrow(/at most 255 bytes/);
  });

  it.each([
    ["a newline", "user\n-1"],
    ["a null byte", "user\u0000-1"],
    ["an interior space", "user -1"],
    ["a tab", "user\t-1"],
    ["a zero-width space", "user\u200B-1"],
    ["a bidi override", "user\u202E-1"],
  ])("refuses %s", async (_label, reportedId) => {
    /**
     * None of these appears in an ObjectId, an MXID, a room id, an alias or an
     * event id, so nothing real is refused. What is refused is an identifier that
     * behaves like something other than an identifier — one that breaks a log
     * line, truncates in a C-backed layer, or renders as a different account than
     * the one the row holds.
     */
    await expect(
      createReport({
        reporter: id("reporter"),
        reportedType: "user",
        reportedId,
        categories: ["spam"],
      }),
    ).rejects.toThrow(/whitespace or control characters/);

    expect(await storedReports()).toHaveLength(0);
  });

  it("still forgives surrounding whitespace, which is trimmed", async () => {
    vi.mocked(subjectProviderFor).mockReturnValue(undefined);

    await createReport({
      reporter: id("reporter"),
      reportedType: "message",
      reportedId: "  message-1  ",
      categories: ["spam"],
    });

    expect((await storedReports())[0]?.reportedId).toBe("message-1");
  });
});

describe("what intake refuses before it writes anything", () => {
  it("refuses an identifier that is not a string, before building a query", async () => {
    /**
     * A truthiness check would pass `{$ne: null}` straight into the lookup. That
     * particular injection is a Mongo shape and drizzle would not build a query
     * from it — but the guard is kept because what it really enforces is that a
     * non-string identifier never reaches storage at all, and `createReport` is
     * exported: a worker or a reconciliation script is under no obligation to have
     * passed the route's validation.
     */
    const injected = { $ne: null } as unknown as string;

    await expect(
      createReport({
        reporter: injected,
        reportedType: "user",
        reportedId: id("user"),
        categories: ["spam"],
      }),
    ).rejects.toThrow(TypeError);

    expect(await storedReports()).toHaveLength(0);
  });

  it("refuses an empty identifier", async () => {
    await expect(
      createReport({
        reporter: "   ",
        reportedType: "user",
        reportedId: id("user"),
        categories: ["spam"],
      }),
    ).rejects.toThrow(/must not be empty/);
  });

  it("refuses a reportedType that is not a reportable type", async () => {
    await expect(
      createReport({
        reporter: id("reporter"),
        reportedType: "device_key" as ReportedType,
        reportedId: id("device"),
        categories: ["spam"],
      }),
    ).rejects.toThrow(/is not a reportable type/);

    expect(await storedReports()).toHaveLength(0);
  });
});
