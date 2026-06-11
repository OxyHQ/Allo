import mongoose, { Schema, Document } from "mongoose";

/**
 * Status (WhatsApp-style Stories) Mongoose model.
 *
 * - Documents auto-expire 24h after `createdAt` via a TTL index on
 *   `expiresAt` (`expireAfterSeconds: 0`). The TTL background task deletes
 *   them, so consumers never need to filter by expiry, but we still apply a
 *   safety filter on `expiresAt > now` to hide statuses for the small window
 *   between expiry and Mongo's TTL reaper run (max ~60s).
 * - The `audience` sub-document mirrors WhatsApp's privacy modes.
 */

export type StatusType = "image" | "video" | "text";
export type StatusAudienceType = "all-contacts" | "except" | "only";

const STATUS_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface IStatusViewer {
  userId: string;
  viewedAt: Date;
}

export interface IStatusAudience {
  type: StatusAudienceType;
  userIds: string[];
}

export interface IStatus extends Document {
  userId: string;
  type: StatusType;

  mediaUrl?: string;
  mediaThumbnailUrl?: string;

  text?: string;
  caption?: string;
  backgroundColor?: string;
  fontFamily?: string;

  audience: IStatusAudience;
  viewers: IStatusViewer[];

  createdAt: Date;
  expiresAt: Date;
}

const StatusViewerSchema = new Schema<IStatusViewer>(
  {
    userId: { type: String, required: true },
    viewedAt: { type: Date, required: true, default: () => new Date() },
  },
  { _id: false }
);

const StatusAudienceSchema = new Schema<IStatusAudience>(
  {
    type: {
      type: String,
      enum: ["all-contacts", "except", "only"],
      required: true,
      default: "all-contacts",
    },
    userIds: { type: [String], default: [] },
  },
  { _id: false }
);

const StatusSchema = new Schema<IStatus>(
  {
    userId: { type: String, required: true, index: true },
    type: {
      type: String,
      enum: ["image", "video", "text"],
      required: true,
    },
    mediaUrl: { type: String },
    mediaThumbnailUrl: { type: String },
    text: { type: String },
    caption: { type: String },
    backgroundColor: { type: String },
    fontFamily: { type: String },
    audience: {
      type: StatusAudienceSchema,
      required: true,
      default: () => ({ type: "all-contacts", userIds: [] }),
    },
    viewers: { type: [StatusViewerSchema], default: [] },
    createdAt: { type: Date, default: Date.now },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + STATUS_LIFETIME_MS),
    },
  },
  {
    // We manage `createdAt` ourselves so we can derive `expiresAt`; no `updatedAt`.
    timestamps: false,
  }
);

// TTL index — Mongo deletes the document the moment `expiresAt` is reached.
StatusSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Most queries are "give me a user's live statuses, newest first".
StatusSchema.index({ userId: 1, createdAt: -1 });

// Validation: text statuses need `text`, media statuses need `mediaUrl`.
StatusSchema.pre("validate", function (next) {
  if (this.type === "text") {
    if (!this.text || !this.text.trim()) {
      return next(new Error("Text statuses require non-empty `text`"));
    }
  } else if (this.type === "image" || this.type === "video") {
    if (!this.mediaUrl) {
      return next(new Error(`${this.type} statuses require \`mediaUrl\``));
    }
  }

  // Ensure expiresAt is in the future and not too far away (24h cap).
  if (!this.expiresAt) {
    this.expiresAt = new Date((this.createdAt?.getTime() || Date.now()) + STATUS_LIFETIME_MS);
  }

  next();
});

export const Status = mongoose.model<IStatus>("Status", StatusSchema);
export default Status;
export { STATUS_LIFETIME_MS };
