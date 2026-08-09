import { Router, Response } from "express";
import type { OxyAuthRequest as AuthRequest } from "@oxyhq/core/server";
import { getRequiredOxyUserId as getAuthenticatedUserId } from "@oxyhq/core/server";
import { getDb } from "../db";
import { listReportsByReporter } from "../db/moderation/reportRepository";
import {
  isReportedType,
  REPORT_CATEGORIES,
  REPORTED_TYPES,
  type ReportCategory,
} from "../db/schema/moderation";
import {
  createReport,
  DuplicateReportError,
} from "../services/moderation/ReportIntakeService";
import {
  reportedIdentifierProblem,
  resolveModerationSubject,
} from "../services/moderation/subjectIdentity";
import { sendErrorResponse, sendSuccessResponse } from "../utils/apiHelpers";
import { logger } from "../utils/logger";

const router = Router();

const MAX_CATEGORIES = 6;
const MAX_DETAILS_LENGTH = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCategories(value: unknown): ReportCategory[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CATEGORIES) {
    return null;
  }
  const allowed = new Set<string>(REPORT_CATEGORIES);
  const parsed: ReportCategory[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !allowed.has(entry)) return null;
    const category = entry as ReportCategory;
    if (!parsed.includes(category)) parsed.push(category);
  }
  return parsed;
}

/**
 * `POST /api/reports` — take a report.
 *
 * A 201 means the report is durably recorded, and — when its type is deliverable —
 * that the promise to deliver it committed in the same transaction. It never means
 * CrowdSource has seen anything.
 *
 * ## Every reported type is accepted here, including the ones that never leave
 *
 * A reported `message` is stored and never delivered, because Allo's server cannot
 * read a message (see `services/moderation/subjects/registry.ts`). That is not a
 * reason to refuse the report: refusing would tell a user being harassed that their
 * report is invalid, when what is actually true is that strangers cannot be shown
 * the evidence. The response deliberately does NOT distinguish the two cases —
 * `delivered` is not echoed back — because a reporter learning which reports leave
 * the deployment learns which reports can be made to disappear.
 *
 * ## `reportedId` accepts an MXID, and that changes nothing downstream
 *
 * What a client has to hand in a Matrix room is an MXID, so this route takes one
 * (§6.2). `Report.reportedId` stays an Oxy user id: the translation happens at this
 * edge and in intake, and the delivery pipeline never learns that Matrix exists.
 * Changing the stored key to an MXID instead would have moved §7.3's dedup key and
 * the subject provider for no gain — CrowdSource judges Oxy accounts.
 *
 * An identifier with no Oxy account behind it — a user on a homeserver Allo does
 * not run, a bridge ghost, a room, an event id — is still accepted and still
 * stored, and is recorded with the reason it cannot be reviewed (§6.3). Refusing it
 * here would be the same mistake as refusing a reported message, and the 400 would
 * additionally tell any client which identifiers Allo considers real.
 */
router.post("/", async (req: AuthRequest, res: Response) => {
  const body: unknown = req.body;
  if (!isRecord(body)) {
    return sendErrorResponse(res, 400, "Bad Request", "A JSON object body is required");
  }

  const reportedType: unknown = body.reportedType;
  if (typeof reportedType !== "string" || !isReportedType(reportedType)) {
    return sendErrorResponse(
      res,
      400,
      "Bad Request",
      `reportedType must be one of: ${REPORTED_TYPES.join(", ")}`,
    );
  }

  const reportedId = body.reportedId;
  if (typeof reportedId !== "string" || reportedId.trim().length === 0) {
    return sendErrorResponse(res, 400, "Bad Request", "reportedId is required");
  }

  /**
   * Bounded before anything reads it. §6.3 makes an unresolvable identifier
   * something Allo STORES rather than refuses, so this is the only place a size
   * and a shape can be imposed on it at all — and without one, a report about a
   * megabyte of attacker-chosen bytes is a permanently stuck outbox slot rather
   * than a rejected request. `createReport` checks again, because it is exported.
   */
  const identifierProblem = reportedIdentifierProblem(reportedId.trim());
  if (identifierProblem !== undefined) {
    return sendErrorResponse(res, 400, "Bad Request", identifierProblem);
  }

  const categories = parseCategories(body.categories);
  if (!categories) {
    return sendErrorResponse(
      res,
      400,
      "Bad Request",
      `categories must be a non-empty array of at most ${MAX_CATEGORIES} values from: ${REPORT_CATEGORIES.join(", ")}`,
    );
  }

  const rawDetails: unknown = body.details;
  if (rawDetails !== undefined && typeof rawDetails !== "string") {
    return sendErrorResponse(res, 400, "Bad Request", "details must be a string");
  }
  const details =
    typeof rawDetails === "string"
      ? rawDetails.trim().slice(0, MAX_DETAILS_LENGTH)
      : undefined;

  try {
    const reporter = getAuthenticatedUserId(req);

    /**
     * A reporter cannot report themselves. Not a correctness guard so much as a
     * refusal to open a case whose subject and reporter are the same principal —
     * §7.3's dedup key would be well-formed and a jury would be asked a question
     * with no adversary.
     *
     * Compared against the RESOLVED subject rather than the raw field, because a
     * client holding a room has an MXID and not an Oxy id (§6.2). Against the raw
     * field this check would pass for `@<own localpart>:allo.you` while intake
     * translated it straight back to the reporter's own Oxy id — a self-report
     * queued for a jury, reachable by sending the id the UI already has.
     */
    const subject = resolveModerationSubject(reportedId);
    if (
      reportedType === "user" &&
      subject.kind === "oxy-account" &&
      subject.reportedId === reporter
    ) {
      return sendErrorResponse(res, 400, "Bad Request", "You cannot report yourself");
    }

    /**
     * The identifier is handed over AS GIVEN. `createReport` resolves it again and
     * that resolution is the one that decides the stored row — one authority for
     * what `reportedId` means, rather than a route that canonicalises and a service
     * that assumes somebody did.
     */
    const { report } = await createReport({
      reporter,
      reportedType,
      reportedId,
      categories,
      ...(details ? { details } : {}),
    });

    return sendSuccessResponse(
      res,
      201,
      { id: report.id, createdAt: report.createdAt },
      "Report received",
    );
  } catch (error) {
    /**
     * A duplicate is answered 200, not 409. Re-reporting the same account is a
     * user repeating themselves, not an error they can act on, and the report they
     * already filed is genuinely on file.
     */
    if (error instanceof DuplicateReportError) {
      return sendSuccessResponse(
        res,
        200,
        { id: error.existing.id, createdAt: error.existing.createdAt },
        "You have already reported this",
      );
    }

    /**
     * The reported id is deliberately absent from this log line. It identifies an
     * account someone reported, and an operational log is not the place to
     * accumulate a list of who has been accused of what.
     */
    logger.error("[Reports] Failed to create report", error);
    return sendErrorResponse(
      res,
      500,
      "Internal Server Error",
      "Failed to record report",
    );
  }
});

/**
 * `GET /api/reports/mine` — the reports this user filed.
 *
 * Scoped to the authenticated reporter with no override, so there is no parameter
 * through which one user could read another's reports. The projection omits
 * `localStatus`, `localStatusReason` and every CrowdSource identifier: those are
 * operational state, and exposing them would tell a reporter which reports left
 * the deployment.
 */
router.get("/mine", async (req: AuthRequest, res: Response) => {
  try {
    const reporter = getAuthenticatedUserId(req);
    /**
     * The projection, the ordering and the cap all live in the repository — it is
     * a user-facing read, so an unbounded page size would be a parameter deciding
     * how much work an authenticated request can ask for.
     *
     * `details` comes back as `string | null` where Mongo left the key absent.
     * Both serialise to a field a client reads with `??`, and `null` is what every
     * other nullable column on this row already emits, so it is not normalised
     * back into `undefined` for this one field.
     */
    return sendSuccessResponse(res, 200, await listReportsByReporter(reporter, getDb()));
  } catch (error) {
    logger.error("[Reports] Failed to list reports", error);
    return sendErrorResponse(
      res,
      500,
      "Internal Server Error",
      "Failed to load reports",
    );
  }
});

export default router;
