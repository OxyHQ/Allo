/**
 * CrowdSource moderation: reports, the inbound event log and the outbox.
 *
 * Ported from `models/Report.ts`, `models/ModerationEvent.ts` and
 * `models/ModerationOutbox.ts`. Two of these three carried a Mongo TTL index;
 * Postgres has none, so both appear in `db/expiry.ts` and that registry is what
 * keeps the retention promise their own doc comments make.
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { createdAt, timestamptz, updatedAt } from "@oxyhq/db";
import { checkArrayWithin, checkNonEmptyArray, checkOneOf } from "./columns";

/**
 * The objects Allo accepts reports about.
 *
 * All three are ACCEPTED. Only `user` is ever delivered — see
 * `services/moderation/subjects/registry.ts`. The other two are stored locally
 * with a recorded reason, which is a different claim from "delivery failed" and
 * is kept distinguishable on purpose.
 */
export const REPORTED_TYPES = ["user", "message", "conversation"] as const;
export type ReportedType = (typeof REPORTED_TYPES)[number];

/**
 * Narrows an arbitrary string to a reportable type.
 *
 * A type guard rather than a membership check at each call site: the compiler
 * has to KNOW the value is a `ReportedType` before it reaches a query or an
 * insert, and an `includes` that returns a plain boolean leaves it a `string` —
 * which is the point at which somebody reaches for a cast.
 *
 * It lives beside the tuple, and the tuple is what renders
 * `reports_reported_type_check`. So the guard, the TypeScript union and the
 * database constraint are three views of ONE list: adding a reportable type is a
 * single edit that a migration then has to catch up with, rather than three
 * edits of which two can be forgotten.
 */
export function isReportedType(value: string): value is ReportedType {
  return (REPORTED_TYPES as readonly string[]).includes(value);
}

export const REPORT_CATEGORIES = [
  "spam",
  "hate_speech",
  "harassment",
  "misinformation",
  "explicit_content",
  "other",
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export const REPORT_STATUSES = ["pending", "reviewed", "resolved", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_LOCAL_STATUSES = [
  "received",
  "queued",
  "submitted",
  "delivery_failed",
  "closed",
] as const;
export type ModerationLocalStatus = (typeof REPORT_LOCAL_STATUSES)[number];

export const REPORT_ENFORCEMENT_ACTIONS = [
  "none",
  "restrict",
  "restore",
  "manual_review",
] as const;
export type ModerationEnforcementAction = (typeof REPORT_ENFORCEMENT_ACTIONS)[number];

export const MODERATION_EVENT_STATES = ["claimed", "queued", "ignored"] as const;
export type ModerationEventState = (typeof MODERATION_EVENT_STATES)[number];

export const MODERATION_OUTBOX_KINDS = ["report.submit", "decision.apply"] as const;
export type ModerationOutboxKind = (typeof MODERATION_OUTBOX_KINDS)[number];

export const MODERATION_OUTBOX_STATUSES = [
  "pending",
  "processing",
  "processed",
  "dead_letter",
] as const;
export type ModerationOutboxStatus = (typeof MODERATION_OUTBOX_STATUSES)[number];

/**
 * The three Mongoose `maxlength` bounds this table carried.
 *
 * Exported because `db/moderation/reportRepository.ts` truncates to them at every
 * write and the two must not be able to disagree — a truncation to 501 characters
 * against a CHECK of 500 is a write that fails for a reason nobody would look for.
 */
export const MAX_REPORT_DETAILS_LENGTH = 500;
export const MAX_REPORT_LOCAL_STATUS_REASON_LENGTH = 300;
export const MAX_REPORT_DELIVERY_ERROR_LENGTH = 2_000;

/**
 * One person's report of one thing.
 *
 * `categories` stays an ARRAY. Mongoose declared it `[String]` with an `enum`
 * AND a separate "at least one" validator, so the port keeps both as separate
 * constraints — containment alone is satisfied by an empty array, which is
 * precisely the case the validator existed to reject.
 *
 * ## The three length bounds are CHECKs as well as truncations
 *
 * Mongoose's `maxlength` REJECTED an over-long value; `reportRepository`
 * TRUNCATES it, which is what every existing caller already did to these three
 * values before handing them over — the route slices `details`, the delivery
 * worker slices its error — so a 201 does not become a 500 for a report whose
 * details ran one character long.
 *
 * That is a guard at one chokepoint, and the database can express the bound
 * itself, so it does both: the repository decides what a REPORTER experiences,
 * and the CHECK decides what is STORABLE. The constraint is therefore
 * unreachable through the repository by construction — which is the point. It
 * exists for the writer that does not exist yet, and for `psql`.
 */
export const reports = pgTable(
  "reports",
  {
    id: text().primaryKey(),
    reportedType: text({ enum: REPORTED_TYPES }).notNull(),
    reportedId: text().notNull(),
    reporter: text().notNull(),
    /**
     * `enum:` narrows the ELEMENT type only — the DDL is still `text[]`, and
     * `reports_categories_within_check` below is what the server enforces. Naming
     * the tuple here means a row READ back is typed as the values that CHECK
     * already guarantees, so a consumer like `allegationsForCategories` receives
     * `ReportCategory[]` rather than `string[]` and needs no cast to look up a
     * code.
     */
    categories: text({ enum: REPORT_CATEGORIES }).array().notNull(),
    details: text(),
    status: text({ enum: REPORT_STATUSES }).notNull().default("pending"),
    localStatus: text({ enum: REPORT_LOCAL_STATUSES }).notNull().default("received"),
    localStatusReason: text(),

    crowdSourceReportId: text(),
    crowdSourceCaseId: text(),
    /** Nullable, not `false` by default: Mongo stored absence for "not yet known". */
    crowdSourceMerged: boolean(),
    submittedAt: timestamptz(),

    decisionId: text(),
    decisionRevision: integer(),
    decisionOutcome: text(),
    decisionStatus: text(),
    decidedAt: timestamptz(),

    enforcedAction: text({ enum: REPORT_ENFORCEMENT_ACTIONS }),
    enforcedAt: timestamptz(),

    contentSnapshotHash: text(),
    lastDeliveryError: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** One report per (reporter, subject) — a second submission is idempotent. */
    uniqueIndex("reports_reporter_reported_id_reported_type_key").on(
      t.reporter,
      t.reportedId,
      t.reportedType,
    ),
    index("reports_local_status_created_at_idx").on(t.localStatus, t.createdAt),
    index("reports_crowd_source_case_id_idx").on(t.crowdSourceCaseId),
    index("reports_reported_id_idx").on(t.reportedId),
    checkOneOf("reports_reported_type_check", t.reportedType, REPORTED_TYPES),
    checkOneOf("reports_status_check", t.status, REPORT_STATUSES),
    checkOneOf("reports_local_status_check", t.localStatus, REPORT_LOCAL_STATUSES),
    checkOneOf("reports_enforced_action_check", t.enforcedAction, REPORT_ENFORCEMENT_ACTIONS),
    checkArrayWithin("reports_categories_within_check", t.categories, REPORT_CATEGORIES),
    checkNonEmptyArray("reports_categories_non_empty_check", t.categories),
    check("reports_decision_revision_check", sql`${t.decisionRevision} >= 1`),
    /**
     * `sql.raw` for the bound, so the constant is rendered as migration TEXT.
     * Interpolating it normally writes a bound-parameter placeholder (`$1`) into
     * the generated DDL, which generates cleanly and fails at APPLY time — DDL
     * cannot carry a parameter.
     */
    check(
      "reports_details_length_check",
      sql.raw(`length(details) <= ${MAX_REPORT_DETAILS_LENGTH}`),
    ),
    check(
      "reports_local_status_reason_length_check",
      sql.raw(`length(local_status_reason) <= ${MAX_REPORT_LOCAL_STATUS_REASON_LENGTH}`),
    ),
    check(
      "reports_last_delivery_error_length_check",
      sql.raw(`length(last_delivery_error) <= ${MAX_REPORT_DELIVERY_ERROR_LENGTH}`),
    ),
  ],
);

/**
 * The inbound webhook dedupe log.
 *
 * `id` is the provider's event id, supplied rather than generated: the claim is
 * `INSERT ... ON CONFLICT (id) DO NOTHING ... RETURNING`, and the empty vs
 * one-row result IS the "already seen" answer. A surrogate key would make every
 * redelivery a new row and dedupe nothing.
 *
 * TTL in Mongo, {@link import('../expiry').EXPIRY_SWEEP_TARGETS} here.
 */
export const moderationEvents = pgTable(
  "moderation_events",
  {
    id: text().primaryKey(),
    type: text(),
    caseId: text(),
    /**
     * The event exactly as published. Stored whole and opaque on purpose: the
     * contract is loose, and a projection would silently drop whatever a newer
     * CrowdSource added.
     */
    payload: jsonb(),
    state: text({ enum: MODERATION_EVENT_STATES }).notNull().default("claimed"),
    receivedAt: timestamptz().notNull().defaultNow(),
    queuedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("moderation_events_case_id_idx").on(t.caseId),
    index("moderation_events_state_received_at_idx").on(t.state, t.receivedAt),
    /** Leading btree on the swept column — without it the sweep is a table scan. */
    index("moderation_events_expires_at_idx").on(t.expiresAt),
    checkOneOf("moderation_events_state_check", t.state, MODERATION_EVENT_STATES),
  ],
);

/**
 * Moderation work that has to happen and has not happened yet.
 *
 * `id` is the caller-supplied idempotency key, exactly as in Mongo: enqueueing
 * the same logical work twice is a unique violation, not a second delivery.
 *
 * TTL in Mongo, {@link import('../expiry').EXPIRY_SWEEP_TARGETS} here — and note
 * what that means for a STALLED dispatcher, which the registry entry states
 * outright rather than leaving to be discovered.
 */
export const moderationOutbox = pgTable(
  "moderation_outbox",
  {
    id: text().primaryKey(),
    kind: text({ enum: MODERATION_OUTBOX_KINDS }).notNull(),
    payloadReportId: text(),
    payloadEventId: text(),
    payloadCaseId: text(),
    /** The decision document, whole and opaque — validated on READ, not on store. */
    payloadDecision: jsonb(),
    status: text({ enum: MODERATION_OUTBOX_STATUSES }).notNull().default("pending"),
    attempts: integer().notNull().default(0),
    availableAt: timestamptz().notNull().defaultNow(),
    leaseOwner: text(),
    leaseUntil: timestamptz(),
    lastError: text(),
    processedAt: timestamptz(),
    expiresAt: timestamptz().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    /** Due work and expired claims stay separate bounded scans, as in Mongo. */
    index("moderation_outbox_status_available_at_created_at_idx").on(
      t.status,
      t.availableAt,
      t.createdAt,
    ),
    index("moderation_outbox_status_lease_until_created_at_idx").on(
      t.status,
      t.leaseUntil,
      t.createdAt,
    ),
    index("moderation_outbox_expires_at_idx").on(t.expiresAt),
    checkOneOf("moderation_outbox_kind_check", t.kind, MODERATION_OUTBOX_KINDS),
    checkOneOf("moderation_outbox_status_check", t.status, MODERATION_OUTBOX_STATUSES),
    check("moderation_outbox_attempts_check", sql`${t.attempts} >= 0`),
  ],
);
