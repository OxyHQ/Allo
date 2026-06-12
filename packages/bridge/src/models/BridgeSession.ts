import mongoose, { Schema, Document, Model } from "mongoose";
import type { Network } from "@allo/shared-types";
import type { EncryptedPayload } from "../crypto";

/**
 * BridgeSession — the connector's OWN persistence of a linked external account's
 * session, stored in the connector's database (NOT Allo's). The Allo backend
 * keeps only an opaque `LinkedAccount` record; the actual bearer credential
 * (Telegram `StringSession`) lives here, encrypted at rest (AES-256-GCM under
 * `BRIDGE_SESSION_KEY` — see `crypto.ts`).
 *
 * `externalSelf` records the connected account's own identity (Telegram user id,
 * username, etc.) so the connector can recognise its own outgoing echoes and
 * report `session_status` to Allo without re-querying Telegram.
 */

/** Lifecycle of a stored session, mirroring Allo's `LinkedAccountStatus`. */
export type BridgeSessionStatus =
  | "pending_login"
  | "active"
  | "expired"
  | "revoked"
  | "error";

/** The connected account's own identity on the external network. */
export interface ExternalSelf {
  id: string;
  username?: string;
  firstName?: string;
  phone?: string;
}

export interface IBridgeSession extends Document {
  ownerUserId: string;
  network: Network;
  /** Encrypted Telegram StringSession (AES-256-GCM); absent until login succeeds. */
  encryptedSession?: EncryptedPayload;
  status: BridgeSessionStatus;
  externalSelf?: ExternalSelf;
  createdAt: Date;
  updatedAt: Date;
}

const EncryptedPayloadSchema = new Schema<EncryptedPayload>(
  {
    iv: { type: String, required: true },
    authTag: { type: String, required: true },
    ciphertext: { type: String, required: true },
  },
  { _id: false }
);

const ExternalSelfSchema = new Schema<ExternalSelf>(
  {
    id: { type: String, required: true },
    username: { type: String },
    firstName: { type: String },
    phone: { type: String },
  },
  { _id: false }
);

const BridgeSessionSchema = new Schema<IBridgeSession>(
  {
    ownerUserId: { type: String, required: true, index: true },
    network: { type: String, required: true },
    encryptedSession: { type: EncryptedPayloadSchema, required: false },
    status: {
      type: String,
      required: true,
      enum: ["pending_login", "active", "expired", "revoked", "error"],
      default: "pending_login",
    },
    externalSelf: { type: ExternalSelfSchema, required: false },
  },
  { timestamps: true }
);

// One session per (owner, network): a user links at most one Telegram account.
BridgeSessionSchema.index({ ownerUserId: 1, network: 1 }, { unique: true });

const BridgeSession: Model<IBridgeSession> =
  (mongoose.models.BridgeSession as Model<IBridgeSession>) ||
  mongoose.model<IBridgeSession>("BridgeSession", BridgeSessionSchema);

export default BridgeSession;
