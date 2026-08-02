import mongoose, { Schema, Document } from "mongoose";
import { BRIDGE_NETWORK_IDS, type BridgeNetworkId } from "../config/bridges";

/**
 * One login attempt in progress (docs/matrix/bridges.md §5.5).
 *
 * ## Nothing the user typed is ever stored here
 *
 * Not the phone number, not the six-digit code, not the 2FA password. Those are
 * relayed to the bridge and forgotten in the same request. This row holds the
 * SHAPE of the conversation — which flow, which step, whose attempt — because
 * that is all the backend needs to route the next answer, and because a
 * collection of half-finished logins containing verification codes would be the
 * single most valuable thing in the database.
 *
 * The one derived value that IS kept lives elsewhere: a phone number's dialling
 * prefix can decide a proxy lease's country, and the COUNTRY is stored on the
 * lease. A country is not a phone number.
 */

/**
 * The step types bridgev2 can return (§5.2) — a closed set from `bridgev2/login.go`.
 *
 * `cookies` and `client_http` are Meta's webview login and `webauthn` is
 * WhatsApp's passkey; all three arrive only with networks this deployment cannot
 * currently enable, and none of them has a client that can render it. They are
 * listed because the type must be able to NAME what a bridge sent in order to
 * refuse it legibly — an unnamed step type would be an unhandled `undefined`.
 */
export const BRIDGE_LOGIN_STEP_TYPES = [
  "user_input",
  "cookies",
  "client_http",
  "display_and_wait",
  "webauthn",
  "complete",
] as const;

export type BridgeLoginStepType = (typeof BRIDGE_LOGIN_STEP_TYPES)[number];

export function isBridgeLoginStepType(value: string): value is BridgeLoginStepType {
  return (BRIDGE_LOGIN_STEP_TYPES as readonly string[]).includes(value);
}

/**
 * How the attempt ended, or that it has not.
 *
 * `expired` is written by the submit path when a caller arrives after
 * `expiresAt`; it is not the only way an attempt expires, because the TTL index
 * removes the row shortly afterwards either way. The value exists so that the
 * request which discovers the expiry can answer "this attempt expired" rather
 * than "no such attempt".
 */
export const BRIDGE_LINK_OUTCOMES = [
  "pending",
  "completed",
  "cancelled",
  "expired",
  "failed",
] as const;

export type BridgeLinkOutcome = (typeof BRIDGE_LINK_OUTCOMES)[number];

export interface BridgeLinkSessionFields {
  /** Opaque, unguessable handle. The only identifier a client ever sees. */
  linkId: string;
  oxyUserId: string;
  network: BridgeNetworkId;
  flowId: string;
  slotId?: string;
  /** The bridge's `loginProcessID`, its handle for this attempt. */
  remoteLoginProcessId: string;
  currentStepId?: string;
  currentStepType?: BridgeLoginStepType;
  expiresAt: Date;
  outcome: BridgeLinkOutcome;
  /** Set when `outcome` is `completed`: the account this attempt produced. */
  resultAccountId?: mongoose.Types.ObjectId;
  /** A bridge error code such as `FI.MAU.TELEGRAM.PHONE_CODE_INVALID`. Never user input. */
  failureCode?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeanBridgeLinkSession extends BridgeLinkSessionFields {
  _id: mongoose.Types.ObjectId;
}

export interface IBridgeLinkSession
  extends BridgeLinkSessionFields,
    Document<mongoose.Types.ObjectId> {
  _id: mongoose.Types.ObjectId;
}

const BridgeLinkSessionSchema = new Schema<IBridgeLinkSession>(
  {
    linkId: { type: String, required: true, unique: true },
    oxyUserId: { type: String, required: true, index: true },
    network: { type: String, enum: BRIDGE_NETWORK_IDS, required: true },
    flowId: { type: String, required: true, maxlength: 200 },
    slotId: { type: String },
    remoteLoginProcessId: { type: String, required: true, maxlength: 200 },
    currentStepId: { type: String, maxlength: 200 },
    currentStepType: { type: String, enum: BRIDGE_LOGIN_STEP_TYPES },
    expiresAt: { type: Date, required: true },
    outcome: {
      type: String,
      enum: BRIDGE_LINK_OUTCOMES,
      required: true,
      default: "pending",
    },
    resultAccountId: { type: Schema.Types.ObjectId },
    failureCode: { type: String, maxlength: 200 },
  },
  { timestamps: true },
);

/**
 * Mongo removes the row once `expiresAt` passes (§5.5).
 *
 * `expireAfterSeconds: 0` means "at the time in the field", not "zero seconds
 * from now" — the row's own deadline decides. An abandoned attempt therefore
 * disappears without a sweep, which is the correct lifetime for a record whose
 * only purpose is to route the next answer in a conversation that stopped.
 */
BridgeLinkSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
/** "Does this user already have an attempt open on this network?" */
BridgeLinkSessionSchema.index({ oxyUserId: 1, network: 1, outcome: 1 });

export const BridgeLinkSession = mongoose.model<IBridgeLinkSession>(
  "BridgeLinkSession",
  BridgeLinkSessionSchema,
);
export default BridgeLinkSession;
