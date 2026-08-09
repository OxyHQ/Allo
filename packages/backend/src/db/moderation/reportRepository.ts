/**
 * `reports` — one person's report of one thing, and the state of Allo's own
 * attempt to get it reviewed.
 *
 * A report is a receipt and an integration state, never a verdict. CrowdSource owns
 * cases, reviews and decisions; the decision columns here are a CACHE of a
 * published revision, overwritten by a later revision and never edited in place.
 *
 * ## Absent optionals come back as `null`, not `undefined`
 *
 * Deliberately, and this is the one place in this domain where the Mongo shape is
 * NOT restored. `ModerationOutboxEvent` is a defined interface whose readers test
 * `=== undefined`, so `moderationOutboxRepository` normalizes it; a report row has
 * no such interface — it is fifteen optional columns, and fifteen lines of
 * `x === null ? {} : { … }` whose only job would be to restore a distinction
 * Postgres does not make. Readers use `??`, which is what `decisionRevision ?? 0`
 * in `ModerationDecisionWorker` already does, and the one place a `string | null`
 * must become a `string | undefined` (`details`, handed to the SDK's `ReportInput`)
 * says so at that call site.
 *
 * ## Three Mongoose `maxlength` bounds land here
 *
 * `details` (500), `localStatusReason` (300) and `lastDeliveryError` (2 000) were
 * bounded by the Mongoose schema; `db/schema/moderation.ts` carries no CHECK for
 * any of them, so the bound has nowhere else to live and is applied at every write
 * below. It TRUNCATES where Mongoose REJECTED, which is what every existing caller
 * already does to the same values before handing them over — the route slices
 * `details`, the delivery worker slices its error — so this makes the bound hold
 * for callers that do not, rather than turning a 201 into a 500 for a report whose
 * details ran one character long.
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { uuidv7 } from "@oxyhq/db";
import { getDb, type AlloDatabaseOrTransaction } from "../index";
import {
  reports,
  type ModerationEnforcementAction,
  type ModerationLocalStatus,
  type ReportCategory,
  type ReportStatus,
  type ReportedType,
} from "../schema/moderation";

/** A stored report, exactly as the table holds it. */
export type ModerationReport = typeof reports.$inferSelect;

const MAX_DETAILS_LENGTH = 500;
const MAX_LOCAL_STATUS_REASON_LENGTH = 300;
const MAX_DELIVERY_ERROR_LENGTH = 2_000;

/**
 * The ceiling on a reporter's own list.
 *
 * A cap rather than a caller's choice: the projection this bounds is served
 * straight to a user, and an unbounded page size would be a parameter that decides
 * how much work an authenticated request can ask for.
 */
const MAX_REPORTS_PER_READ = 100;

function bounded(value: string | undefined, limit: number): string | undefined {
  return value === undefined ? undefined : value.slice(0, limit);
}

/**
 * The one report a reporter can have about one object.
 *
 * Read inside intake's transaction so the duplicate answer and the insert that
 * follows it see the same snapshot. It is not the only defence — the unique index
 * `reports_reporter_reported_id_reported_type_key` is, and a concurrent duplicate
 * still surfaces there as a `23505` a caller must recognise with
 * `isUniqueViolation` rather than a message regex.
 */
export async function findReportBySubject(
  query: { reporter: string; reportedId: string; reportedType: ReportedType },
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<ModerationReport | undefined> {
  const [row] = await db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.reporter, query.reporter),
        eq(reports.reportedId, query.reportedId),
        eq(reports.reportedType, query.reportedType),
      ),
    )
    .limit(1);
  return row;
}

/** One report by its own id. */
export async function findReportById(
  reportId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<ModerationReport | undefined> {
  const [row] = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1);
  return row;
}

/**
 * The report a decision names, found by the case CrowdSource opened for it.
 *
 * `crowd_source_case_id` is not unique — §7.3 lets CrowdSource MERGE reports into
 * one case, so several local reports can legitimately name it. This returns the
 * first, matching the Mongo `findOne` it replaces; nothing downstream is defined
 * for the merged case yet, and inventing an ordering here would be a policy this
 * repository is not the place to decide.
 */
export async function findReportByCaseId(
  caseId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<ModerationReport | undefined> {
  const [row] = await db
    .select()
    .from(reports)
    .where(eq(reports.crowdSourceCaseId, caseId))
    .limit(1);
  return row;
}

/**
 * Store a report.
 *
 * The `db` parameter has NO default, unlike every read above. Intake's two writes —
 * this row and its delivery event — are a pair that must commit together, and a
 * default would make passing nothing, which is the root connection, the easiest
 * thing to write. The outbox enqueue REFUSES the root outright; a report has no
 * second write of its own to be refused for, so what this can do instead is make
 * the handle a decision the caller states rather than one it omits.
 *
 * The id is generated here. `reports.id` is a bare `text().primaryKey()` with no
 * database default, so a row inserted without one fails — this is where Mongo's
 * `_id` generation went, and the value is the uuid v7 CONVENTIONS.md specifies for
 * a row created after the cutover.
 */
export async function insertReport(
  input: {
    reporter: string;
    reportedType: ReportedType;
    reportedId: string;
    categories: readonly ReportCategory[];
    details?: string;
    status?: ReportStatus;
    localStatus: ModerationLocalStatus;
    localStatusReason?: string;
  },
  db: AlloDatabaseOrTransaction,
): Promise<ModerationReport> {
  const [row] = await db
    .insert(reports)
    .values({
      id: uuidv7(),
      reporter: input.reporter,
      reportedType: input.reportedType,
      reportedId: input.reportedId,
      categories: [...input.categories],
      details: bounded(input.details, MAX_DETAILS_LENGTH),
      status: input.status ?? "pending",
      localStatus: input.localStatus,
      localStatusReason: bounded(
        input.localStatusReason,
        MAX_LOCAL_STATUS_REASON_LENGTH,
      ),
    })
    .returning();
  return row;
}

/**
 * The reports one person filed, newest first.
 *
 * The projection is the route's: `localStatus`, `localStatusReason` and every
 * CrowdSource identifier are operational state, and returning them would tell a
 * reporter which of their reports left the deployment.
 */
export async function listReportsByReporter(
  reporter: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<
  Pick<
    ModerationReport,
    "id" | "reportedType" | "reportedId" | "categories" | "details" | "status" | "createdAt"
  >[]
> {
  return await db
    .select({
      id: reports.id,
      reportedType: reports.reportedType,
      reportedId: reports.reportedId,
      categories: reports.categories,
      details: reports.details,
      status: reports.status,
      createdAt: reports.createdAt,
    })
    .from(reports)
    .where(eq(reports.reporter, reporter))
    .orderBy(desc(reports.createdAt))
    .limit(MAX_REPORTS_PER_READ);
}

/**
 * Record what CrowdSource decided, if this is still the newest revision.
 *
 * A compare-and-set on `decision_revision`, and the comparison is
 * `is not distinct from` rather than `=`. That is not a stylistic choice: the
 * expected value is NULL for every report that has never been decided, which is
 * most of them, and `decision_revision = NULL` is NULL — so an `eq` here would
 * match no row at all and the FIRST decision about every report would be silently
 * dropped. §10.6 allows redelivery and reordering, so the guard has to hold against
 * what is stored rather than against arrival order.
 *
 * `enforcedAction` is the action Allo WOULD take. `enforced_at` is deliberately not
 * written: nothing acts yet, and a timestamp claiming otherwise would be the record
 * of an enforcement that never happened.
 *
 * @returns `false` when a concurrent writer already moved the revision.
 */
export async function applyReportDecision(
  input: {
    reportId: string;
    expectedRevision: number | null;
    status: ReportStatus;
    localStatus: ModerationLocalStatus;
    decisionId: string;
    decisionRevision: number;
    decisionOutcome: string;
    decisionStatus: string;
    decidedAt: Date;
    enforcedAction: ModerationEnforcementAction;
  },
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const applied = await db
    .update(reports)
    .set({
      status: input.status,
      localStatus: input.localStatus,
      decisionId: input.decisionId,
      decisionRevision: input.decisionRevision,
      decisionOutcome: input.decisionOutcome,
      decisionStatus: input.decisionStatus,
      decidedAt: input.decidedAt,
      enforcedAction: input.enforcedAction,
    })
    .where(
      and(
        eq(reports.id, input.reportId),
        sql`${reports.decisionRevision} is not distinct from ${input.expectedRevision}`,
      ),
    )
    .returning({ id: reports.id });
  return applied.length === 1;
}

/**
 * The report left for review.
 *
 * `localStatusReason` and `lastDeliveryError` are cleared, because both describe a
 * state this row has just left and a stale reason is worse than none.
 */
export async function markReportSubmitted(
  input: {
    reportId: string;
    crowdSourceReportId: string;
    crowdSourceCaseId: string;
    crowdSourceMerged: boolean;
    contentSnapshotHash: string;
    submittedAt?: Date;
  },
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(reports)
    .set({
      localStatus: "submitted",
      crowdSourceReportId: input.crowdSourceReportId,
      crowdSourceCaseId: input.crowdSourceCaseId,
      crowdSourceMerged: input.crowdSourceMerged,
      contentSnapshotHash: input.contentSnapshotHash,
      submittedAt: input.submittedAt ?? new Date(),
      lastDeliveryError: null,
      localStatusReason: null,
    })
    .where(eq(reports.id, input.reportId))
    .returning({ id: reports.id });
  return updated.length === 1;
}

/**
 * A delivery attempt failed, and it is visible on the REPORT rather than only in
 * the outbox row.
 *
 * `delivery_failed` is the state the reconciliation sweep reads; leaving the report
 * at `queued` while the outbox quietly backed off would hide the problem in a table
 * nobody looks at.
 */
export async function markReportDeliveryFailed(
  reportId: string,
  error: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(reports)
    .set({
      localStatus: "delivery_failed",
      lastDeliveryError: error.slice(0, MAX_DELIVERY_ERROR_LENGTH),
    })
    .where(eq(reports.id, reportId))
    .returning({ id: reports.id });
  return updated.length === 1;
}

/**
 * Close a report there is genuinely nothing left to do about — the reported account
 * was deleted between the report and its delivery.
 *
 * The reason is stored rather than left to be inferred, because a report closed for
 * this and a report never delivered because its TYPE has no route out are different
 * claims that end up in adjacent states, and in Allo the second is the common case.
 */
export async function closeUndeliverableReport(
  reportId: string,
  reason: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<boolean> {
  const updated = await db
    .update(reports)
    .set({
      localStatus: "closed",
      localStatusReason: reason.slice(0, MAX_LOCAL_STATUS_REASON_LENGTH),
    })
    .where(eq(reports.id, reportId))
    .returning({ id: reports.id });
  return updated.length === 1;
}
