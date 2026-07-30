import mongoose, { Schema, Document } from "mongoose";

/**
 * A report is a receipt and an integration state, never a verdict.
 *
 * CrowdSource owns cases, reviews and decisions (§14.3); this collection keeps
 * what Allo needs to answer its own reporter, drive its own delivery and record
 * its own enforcement. Nothing here is the source of truth for whether a rule was
 * broken, and the decision fields below are a CACHE of a published revision —
 * overwritten by a later revision, never edited in place.
 *
 * ## This collection never holds message content, and that is structural
 *
 * Allo is end-to-end encrypted. `details` is the reporter's own words, bounded and
 * written by the reporter; every other field is an identifier, a status or a hash.
 * There is no field here for reported material, and there must never be one — see
 * `services/moderation/subjects/registry.ts` for why the only reportable subject is
 * an account.
 */

/**
 * The objects Allo accepts reports about.
 *
 * All three are ACCEPTED. Only `USER` is ever delivered — see the registry. The
 * other two are stored locally with a recorded reason, which is a different claim
 * from "delivery failed" and is kept distinguishable on purpose.
 */
export enum ReportedType {
  USER = "user",
  MESSAGE = "message",
  CONVERSATION = "conversation",
}

export enum ReportCategory {
  SPAM = "spam",
  HATE_SPEECH = "hate_speech",
  HARASSMENT = "harassment",
  MISINFORMATION = "misinformation",
  EXPLICIT_CONTENT = "explicit_content",
  OTHER = "other",
}

/** The legacy moderation-lifecycle axis, derived from `localStatus`, never hand-written. */
export enum ReportStatus {
  PENDING = "pending",
  REVIEWED = "reviewed",
  RESOLVED = "resolved",
  DISMISSED = "dismissed",
}

/** §14.3's local integration states. */
export type ModerationLocalStatus =
  | "received"
  | "queued"
  | "submitted"
  | "delivery_failed"
  | "closed";

export const REPORT_LOCAL_STATUSES: readonly ModerationLocalStatus[] = [
  "received",
  "queued",
  "submitted",
  "delivery_failed",
  "closed",
];

/**
 * What Allo can actually carry out against an account.
 *
 * Shorter than other Oxy applications' lists, and necessarily so: Allo cannot
 * label, hide or remove a message, because it cannot read one. The actions here
 * are the ones that operate on an ACCOUNT's ability to reach other people.
 */
export type ModerationEnforcementAction = "none" | "restrict" | "restore" | "manual_review";

export const REPORT_ENFORCEMENT_ACTIONS: readonly ModerationEnforcementAction[] = [
  "none",
  "restrict",
  "restore",
  "manual_review",
];

/**
 * A report's stored fields, without the Document machinery.
 *
 * Read paths use `.lean()`, and a lean document is NOT an `IReport` — it has no
 * `save`, no `id` getter and no virtuals. Typing one as `IReport` would be a claim
 * the runtime does not honour: `report.id` on a lean row is `undefined` rather than
 * a type error.
 */
export interface ReportFields {
  reportedType: ReportedType;
  reportedId: string;
  reporter: string;
  categories: ReportCategory[];
  /** The reporter's own description. Never reported material. */
  details?: string;
  status: ReportStatus;
  /** Delivery/integration axis (§14.3). */
  localStatus: ModerationLocalStatus;
  /** Why there is no durable route to CrowdSource, when `localStatus` says so. */
  localStatusReason?: string;

  crowdSourceReportId?: string;
  crowdSourceCaseId?: string;
  /** Set when CrowdSource merged this report into an existing case (§7.3). */
  crowdSourceMerged?: boolean;
  submittedAt?: Date;

  decisionId?: string;
  decisionRevision?: number;
  decisionOutcome?: string;
  decisionStatus?: string;
  decidedAt?: Date;

  enforcedAction?: ModerationEnforcementAction;
  enforcedAt?: Date;

  /**
   * SHA-256 of the exact material that was sent for review (§5.6).
   *
   * For an account this is a hash of the profile representation as it stood when
   * the report left, so a decision about an older profile stays recognisable as
   * being about an older profile. It is a digest, not a copy: it cannot be
   * reversed into the material it summarises.
   */
  contentSnapshotHash?: string;
  /** Last delivery failure, truncated. Never carries reported material. */
  lastDeliveryError?: string;

  createdAt: Date;
  updatedAt: Date;
}

/** A lean report row, as every read path returns it. */
export interface LeanReport extends ReportFields {
  _id: mongoose.Types.ObjectId;
}

export interface IReport extends ReportFields, Document<mongoose.Types.ObjectId> {
  _id: mongoose.Types.ObjectId;
}

/**
 * Narrows an arbitrary string to a reportable type.
 *
 * A type guard rather than a membership check at each call site: the compiler has
 * to KNOW the value is a `ReportedType` before it reaches a query or a `create`,
 * and an `includes` that returns a plain boolean leaves it a `string` — which is
 * the point at which somebody reaches for a cast.
 */
export function isReportedType(value: string): value is ReportedType {
  return (Object.values(ReportedType) as string[]).includes(value);
}

const ReportSchema = new Schema<IReport>(
  {
    reportedType: {
      type: String,
      enum: Object.values(ReportedType),
      required: true,
    },
    reportedId: { type: String, required: true, index: true },
    reporter: { type: String, required: true, index: true },
    categories: {
      type: [String],
      enum: Object.values(ReportCategory),
      required: true,
      validate: {
        validator: (value: string[]) => Array.isArray(value) && value.length > 0,
        message: "At least one category is required",
      },
    },
    details: { type: String, maxlength: 500 },
    status: {
      type: String,
      enum: Object.values(ReportStatus),
      default: ReportStatus.PENDING,
      index: true,
    },
    localStatus: {
      type: String,
      enum: REPORT_LOCAL_STATUSES,
      default: "received",
      required: true,
      index: true,
    },
    localStatusReason: { type: String, maxlength: 300 },

    crowdSourceReportId: { type: String },
    crowdSourceCaseId: { type: String, index: true },
    crowdSourceMerged: { type: Boolean },
    submittedAt: { type: Date },

    decisionId: { type: String },
    decisionRevision: { type: Number, min: 1 },
    decisionOutcome: { type: String },
    decisionStatus: { type: String },
    decidedAt: { type: Date },

    enforcedAction: { type: String, enum: REPORT_ENFORCEMENT_ACTIONS },
    enforcedAt: { type: Date },

    contentSnapshotHash: { type: String },
    lastDeliveryError: { type: String, maxlength: 2_000 },
  },
  { timestamps: true },
);

/** One report per reporter per object: re-reporting is idempotent, not additive. */
ReportSchema.index({ reporter: 1, reportedId: 1, reportedType: 1 }, { unique: true });
/** The reconciliation sweep scans by delivery state, oldest first (§14.4). */
ReportSchema.index({ localStatus: 1, createdAt: 1 });

export const Report = mongoose.model<IReport>("Report", ReportSchema);
export default Report;
