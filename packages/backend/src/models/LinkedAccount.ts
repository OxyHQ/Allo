import mongoose, { Schema, Document } from "mongoose";
import type { Network } from "@allo/shared-types";

export type LinkedAccountStatus =
  | "pending_login"
  | "active"
  | "expired"
  | "revoked"
  | "error";

/**
 * A link between an Allo user and ONE external network account (e.g. their
 * Telegram). One row per (userId, network).
 *
 * `sessionRef` is an OPAQUE handle the bridge connector uses to find the live
 * session it holds on its side. !!! IT NEVER CONTAINS CREDENTIALS, TOKENS,
 * COOKIES, OR ANY SECRET MATERIAL !!! The Allo backend stores no external
 * credentials whatsoever — the connector owns the session; this is just a
 * reference so we can ask the connector about it.
 */
export interface ILinkedAccount extends Document {
  userId: string; // Oxy user ID
  network: Network;
  status: LinkedAccountStatus;
  /** The user's own identity ON the external network. */
  externalSelf?: {
    externalId: string;
    username?: string;
    displayName?: string;
    avatarUrl?: string;
    phoneHint?: string;
  };
  /** OPAQUE reference to the connector-held session — NEVER a credential/token. */
  sessionRef?: string;
  lastSyncAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const ExternalSelfSchema = new Schema(
  {
    externalId: { type: String, required: true },
    username: { type: String },
    displayName: { type: String },
    avatarUrl: { type: String },
    phoneHint: { type: String },
  },
  { _id: false }
);

const LinkedAccountSchema = new Schema<ILinkedAccount>(
  {
    userId: { type: String, required: true, index: true },
    network: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending_login", "active", "expired", "revoked", "error"],
      required: true,
      default: "pending_login",
    },
    externalSelf: { type: ExternalSelfSchema },
    // OPAQUE — never holds credentials/tokens. See the interface doc above.
    sessionRef: { type: String },
    lastSyncAt: { type: Date },
  },
  { timestamps: true }
);

// One linked account per (user, network).
LinkedAccountSchema.index({ userId: 1, network: 1 }, { unique: true });

export const LinkedAccount = mongoose.model<ILinkedAccount>(
  "LinkedAccount",
  LinkedAccountSchema
);
export default LinkedAccount;
