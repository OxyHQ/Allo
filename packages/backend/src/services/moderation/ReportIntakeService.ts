import mongoose, { type ClientSession } from "mongoose";
import Report, {
  isReportedType,
  ReportCategory,
  ReportStatus,
  ReportedType,
  type IReport,
  type LeanReport,
  type ModerationLocalStatus,
} from "../../models/Report";
import {
  enqueueModerationOutboxEvent,
  reportSubmitEventId,
} from "./ModerationOutboxService";
import { reportedIdentifierProblem, resolveModerationSubject } from "./subjectIdentity";
import { subjectProviderFor } from "./subjects/registry";

/**
 * Storing a report and, when there is somewhere to send it, the promise to deliver
 * it — in one operation.
 *
 * This is §7.1, and it is the only thing in the integration a user waits for. A
 * 201 from `POST /reports` means the report row and its outbox event committed
 * together. It does NOT mean CrowdSource accepted anything — CrowdSource may be
 * unreachable, mid-deploy or not yet configured, and the reporter is told their
 * report was received either way, because it was.
 *
 * The transaction is the whole mechanism. Two writes outside one would give two
 * failure modes that are both silent: a report with no delivery event (nothing
 * will ever send it, and nobody finds out until somebody asks why a case never
 * opened) or a delivery event with no report (a worker looking up an id that was
 * rolled back). Neither surfaces as an error at the moment it happens, which is
 * exactly why this has to be atomic rather than carefully ordered.
 *
 * The one report with NO delivery event is the one whose type has no subject
 * provider, and that is a different claim entirely: not "delivery failed" but
 * "there was never a route out of this application for this kind of object". In
 * Allo that is the common case, not the exception — a reported message is stored
 * and never leaves, because the server cannot read one. The two must not be
 * conflated, which is why they are different `localStatus` values and why the
 * absent route is written down as a reason rather than inferred from a missing row.
 *
 * ## Matrix adds a SECOND way for a report to have nowhere to go
 *
 * A type can have no provider, and now a SUBJECT can have no Oxy account: a user on
 * a homeserver Allo does not run, a bridge ghost, a room, an event id
 * (docs/matrix/data-model.md §6.3, §6.5). Those two facts are independent — a
 * perfectly deliverable `user` report can name a WhatsApp ghost — so they are
 * decided separately here and produce different sentences on the row.
 *
 * Left undecided, the second one is not a stored state at all but a 404 arriving
 * hours later at `ModerationDeliveryWorker`, which closes the report saying "the
 * reported account no longer exists" — a claim that was never true about an account
 * that never existed. §6.3's requirement is that the decision be made and written,
 * and that is what turns an indistinguishable silence into a row somebody can read.
 */

const TRANSACTION_OPTIONS = {
  readPreference: "primary" as const,
  readConcern: { level: "snapshot" as const },
  writeConcern: { w: "majority" as const },
};

export class DuplicateReportError extends Error {
  readonly existing: LeanReport;

  constructor(existing: LeanReport) {
    super("This item has already been reported by this reporter.");
    this.name = "DuplicateReportError";
    this.existing = existing;
  }
}

/**
 * Refuses an identifier that is not a non-empty string, at the point the QUERY is
 * built.
 *
 * `CreateReportInput` types these as strings and the route rejects a missing one,
 * but a type is erased at runtime and a truthiness check passes `{$ne: null}`.
 * Handed that, `findOne` matches an UNRELATED report and this function answers
 * "you already reported this" about somebody else's row — and `create` would then
 * store a query operator where an id belongs.
 *
 * The check lives here rather than at the route because `createReport` is
 * exported: a worker, a reconciliation script or a future admin path is under no
 * obligation to have passed the route's validation, and a guard that only exists
 * at one caller is a guard that holds until the second one arrives.
 */
function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new TypeError(
      `createReport: '${field}' must be a string, received ${value === null ? "null" : typeof value}.`,
    );
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new TypeError(`createReport: '${field}' must not be empty.`);
  }
  return trimmed;
}

export interface CreateReportInput {
  reporter: string;
  reportedType: ReportedType;
  reportedId: string;
  categories: ReportCategory[];
  details?: string;
}

export interface CreateReportResult {
  report: IReport;
  /**
   * The durable delivery event.
   *
   * Absent exactly when the reported type has no subject provider — the report was
   * stored and there is nothing to deliver it, by design rather than by failure.
   */
  outboxEventId?: string;
}

/**
 * Why a report is not going anywhere, in words an operator can read.
 *
 * Stored on the row rather than left to be inferred from a missing outbox event. A
 * missing row is also what a lost write looks like, and the two need to be
 * distinguishable months later without re-deriving which types had providers at
 * the time. Bounded by the schema's 300-character limit.
 */
function localOnlyReason(reportedType: string): string {
  return (
    `Allo has no moderation subject provider for '${reportedType}', so this report is ` +
    "recorded locally and is not sent for community review. Message content is " +
    "end-to-end encrypted and cannot be disclosed to reviewers."
  );
}

interface ReportRouting {
  readonly reportedId: string;
  readonly deliverable: boolean;
  readonly localStatusReason?: string;
}

/**
 * What this report is about and whether it can leave, decided from the identifier
 * alone.
 *
 * The two facts are ordered, and the order is a claim rather than a convenience.
 * "Allo never delivers reports of this TYPE" outranks "this particular subject has
 * no Oxy account", because the first is permanent and the second is about one row:
 * a reported message stays local whether its id is an Allo message id, a Matrix
 * event id or anything else, and saying so is more useful to whoever reads the row
 * than a sentence about Matrix identifiers.
 *
 * The ordering is in the CONTROL FLOW and not only in the returned reason, which is
 * the part that was wrong when this function was first written. Resolving before
 * the type check ran the MXID -> Oxy translation for every reported type, so a
 * `message` report whose id happened to start with `@` and match this homeserver
 * had its `reportedId` rewritten to the MXID's localpart -- a string shaped exactly
 * like an Oxy user id, stored as the identity of a reported MESSAGE, where that
 * translation means nothing at all. It also made every reported message read
 * `bridgesConfig()` to compute an answer that was then thrown away.
 *
 * Nothing is resolved for a type that has no provider. The identifier is stored as
 * the caller gave it, which for those types is the only thing it can honestly be.
 */
function routeReport(reportedType: ReportedType, reportedId: string): ReportRouting {
  if (subjectProviderFor(reportedType) === undefined) {
    return {
      reportedId,
      deliverable: false,
      localStatusReason: localOnlyReason(reportedType),
    };
  }

  const subject = resolveModerationSubject(reportedId);
  if (subject.kind === "not-an-oxy-account") {
    return {
      reportedId: subject.reportedId,
      deliverable: false,
      localStatusReason: subject.reason,
    };
  }

  return { reportedId: subject.reportedId, deliverable: true };
}

async function inTransaction<T>(
  operation: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  let result: T | undefined;
  try {
    await session.withTransaction(async () => {
      result = await operation(session);
    }, TRANSACTION_OPTIONS);
    if (result === undefined) {
      throw new Error("Report intake transaction completed without a result");
    }
    return result;
  } finally {
    await session.endSession();
  }
}

/**
 * Store the report, and queue its delivery in the same transaction.
 *
 * Delivery is queued when — and only when — the reported type has a subject
 * provider AND the reported subject is an Oxy account. Either miss stores the
 * report at `received` with its own reason recorded, which is the behaviour a
 * reporter should get regardless: the report is a receipt and a local record, and
 * it still counts as a signal about an account even when its material can never be
 * reviewed.
 *
 * That branch is the reason the two writes stay in one transaction rather than
 * being ordered carefully. `routeReport` answers BEFORE the transaction body
 * decides anything, so `localStatus`, `localStatusReason` and the presence of an
 * outbox row are decided together from one answer — a report can never commit as
 * `queued` with nothing to deliver it, nor as `received` with a delivery event that
 * will try anyway.
 *
 * Intake deliberately does not read `CROWDSOURCE_ENABLED`. A report taken while the
 * integration is off still gets its delivery event, so turning the flag on delivers
 * the backlog instead of stranding it — the dispatcher is what is gated, not the
 * durable record. Nothing here is conditional on a third party's state; only on
 * whether this application can describe the object at all.
 */
export async function createReport(input: CreateReportInput): Promise<CreateReportResult> {
  const reporter = requireIdentifier(input.reporter, "reporter");
  const rawReportedId = requireIdentifier(input.reportedId, "reportedId");

  /**
   * Bounded HERE as well as at the route, and for the same reason `requireIdentifier`
   * exists at all: this function is exported and the route is only its first caller.
   *
   * Section 6.3 is what makes the bound necessary rather than tidy. An identifier
   * that resolves to nothing is deliberately STORED instead of refused, so an
   * unbounded one is untrusted bytes reaching Mongo by design -- and a `user` report
   * carrying a megabyte of them still gets a delivery event, whose `getUserById`
   * fails with something `isOxyUserNotFound` cannot recognise and the outbox
   * therefore retries as an outage forever.
   */
  const identifierProblem = reportedIdentifierProblem(rawReportedId);
  if (identifierProblem !== undefined) {
    throw new TypeError(`createReport: ${identifierProblem}.`);
  }

  const rawReportedType = requireIdentifier(input.reportedType, "reportedType");
  if (!isReportedType(rawReportedType)) {
    throw new TypeError(
      `createReport: reportedType '${rawReportedType}' is not a reportable type.`,
    );
  }
  const reportedType: ReportedType = rawReportedType;

  /**
   * Re-derived here rather than trusted from the caller, for the reason
   * `requireIdentifier` gives about itself: `createReport` is exported, and the
   * route is only its first caller. A worker or a reconciliation script handing
   * over a raw MXID must produce the same stored row as the route does, or the
   * unique index would let one account be reported twice by one reporter — once
   * under its Oxy id and once under its MXID — and §7.3's "one penalty per
   * incident" would fail with nothing failing in a test.
   *
   * The DELIVERY pipeline still never does this: §6.2 puts the translation at the
   * edge, and intake is the edge. Everything past this line sees an Oxy user id.
   */
  const { reportedId, deliverable, localStatusReason } = routeReport(
    reportedType,
    rawReportedId,
  );
  const localStatus: ModerationLocalStatus = deliverable ? "queued" : "received";

  return await inTransaction(async (session) => {
    const existing = await Report.findOne({ reporter, reportedId, reportedType })
      .session(session)
      .lean<LeanReport | null>();
    if (existing) throw new DuplicateReportError(existing);

    const [report] = await Report.create(
      [
        {
          reportedType,
          reportedId,
          reporter,
          categories: input.categories,
          details: input.details,
          status: ReportStatus.PENDING,
          localStatus,
          ...(localStatusReason === undefined ? {} : { localStatusReason }),
        },
      ],
      { session },
    );

    if (!deliverable) return { report };

    const reportId = report._id.toString();
    const outboxEventId = await enqueueModerationOutboxEvent(
      {
        eventId: reportSubmitEventId(reportId),
        kind: "report.submit",
        payload: { reportId },
      },
      session,
    );

    return { report, outboxEventId };
  });
}
