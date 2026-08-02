import mongoose, { Schema, Document } from "mongoose";
import { BRIDGE_NETWORK_IDS, type BridgeNetworkId } from "../config/bridges";

/**
 * One remote account a user has linked through a bridge (docs/matrix/bridges.md §5.5).
 *
 * ## This collection holds no credentials, and that is structural
 *
 * A WhatsApp or Telegram session lives in the BRIDGE's database, encrypted at
 * rest, and Allo's backend never sees it. What is here is an identifier, a
 * status and a display name — enough to render an account list and to know when
 * to ask the user to re-link, and nothing that could log anybody in anywhere.
 * That frontier is worth keeping explicit: a field for "the session" would be
 * easy to add and impossible to walk back.
 */

/**
 * The bridge's own vocabulary, which is a CLOSED set (§5.3).
 *
 * Stored verbatim in `rawState` alongside the collapsed state, because the
 * collapse throws away exactly the distinctions operations needs: `LOGGED_OUT`
 * and `BAD_CREDENTIALS` look identical to a user (re-link) and completely
 * different to us — a rise in `LOGGED_OUT` on one network is the early signal of
 * a ban wave, and it is invisible if only the collapsed state was kept.
 */
export const BRIDGE_STATE_EVENTS = [
  "STARTING",
  "UNCONFIGURED",
  "RUNNING",
  "BRIDGE_UNREACHABLE",
  "CONNECTING",
  "BACKFILLING",
  "CONNECTED",
  "TRANSIENT_DISCONNECT",
  "BAD_CREDENTIALS",
  "UNKNOWN_ERROR",
  "LOGGED_OUT",
] as const;

export type BridgeStateEvent = (typeof BRIDGE_STATE_EVENTS)[number];

export function isBridgeStateEvent(value: string): value is BridgeStateEvent {
  return (BRIDGE_STATE_EVENTS as readonly string[]).includes(value);
}

/**
 * What a user is shown (§5.3). Six states, deliberately coarser than the bridge's
 * eleven: the extra resolution is diagnostic, and a UI that exposed it would be
 * asking users to distinguish `BACKFILLING` from `CONNECTING`.
 */
export const BRIDGE_ACCOUNT_STATES = [
  "linking",
  "connecting",
  "connected",
  "degraded",
  "action_required",
  "failed",
] as const;

export type BridgeAccountState = (typeof BRIDGE_ACCOUNT_STATES)[number];

/** The last thing the bridge said, kept for diagnosis and for the TTL sweep. */
export interface BridgeRawState {
  stateEvent: BridgeStateEvent | "UNKNOWN";
  /** The bridge's machine-readable error code, e.g. `FI.MAU.TELEGRAM.INVALID_PASSWORD`. */
  error?: string;
  message?: string;
  reason?: string;
  /**
   * Seconds this state stays fresh, straight from the bridge (§5.4).
   *
   * `BridgeState.Fill` sets 3600 on error and 21600 otherwise, and the bridge
   * RE-SENDS an unchanged state once its TTL expires. So silence past this
   * window means the process is gone — the one failure mode no webhook can
   * report, and the reason the sweep exists.
   */
  ttl?: number;
  at: Date;
}

/**
 * A narrow, explicit projection of the bridge's `remote_profile`.
 *
 * Not a `Mixed` passthrough. Whatever a remote network chooses to put in a
 * profile arrives here from outside Allo's trust boundary, and a schemaless
 * field would store all of it forever — including fields nobody has looked at.
 */
export interface BridgeRemoteProfile {
  name?: string;
  username?: string;
  phone?: string;
  avatarUrl?: string;
}

export interface BridgeAccountFields {
  oxyUserId: string;
  network: BridgeNetworkId;
  /** The bridge's `UserLogin` id — its handle for this account, used on every `/v3` call. */
  remoteLoginId: string;
  remoteName?: string;
  remoteProfile?: BridgeRemoteProfile;
  /**
   * The dedicated appservice slot serving this account, for networks that need a
   * process of their own (§4.3). Absent for shared-process networks, which is
   * every network this deployment can currently enable.
   */
  slotId?: string;
  state: BridgeAccountState;
  rawState?: BridgeRawState;
  spaceRoomId?: string;
  linkedAt: Date;
  lastStateAt: Date;
  lastConnectedAt?: Date;
  /**
   * The state the user was last pushed about, so a bridge that re-sends
   * `BAD_CREDENTIALS` every hour does not produce a notification every hour
   * (§5.4 step 4). Cleared whenever the account recovers, so a SECOND genuine
   * failure after a recovery does notify.
   */
  lastNotifiedState?: BridgeAccountState;
  lastNotifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface LeanBridgeAccount extends BridgeAccountFields {
  _id: mongoose.Types.ObjectId;
}

export interface IBridgeAccount
  extends BridgeAccountFields,
    Document<mongoose.Types.ObjectId> {
  _id: mongoose.Types.ObjectId;
}

const BridgeRawStateSchema = new Schema<BridgeRawState>(
  {
    stateEvent: { type: String, required: true },
    error: { type: String, maxlength: 200 },
    message: { type: String, maxlength: 1_000 },
    reason: { type: String, maxlength: 200 },
    ttl: { type: Number, min: 0 },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const BridgeRemoteProfileSchema = new Schema<BridgeRemoteProfile>(
  {
    name: { type: String, maxlength: 200 },
    username: { type: String, maxlength: 200 },
    phone: { type: String, maxlength: 50 },
    avatarUrl: { type: String, maxlength: 2_000 },
  },
  { _id: false },
);

const BridgeAccountSchema = new Schema<IBridgeAccount>(
  {
    oxyUserId: { type: String, required: true, index: true },
    network: { type: String, enum: BRIDGE_NETWORK_IDS, required: true },
    remoteLoginId: { type: String, required: true },
    remoteName: { type: String, maxlength: 200 },
    remoteProfile: { type: BridgeRemoteProfileSchema },
    slotId: { type: String },
    state: {
      type: String,
      enum: BRIDGE_ACCOUNT_STATES,
      required: true,
      default: "linking",
    },
    rawState: { type: BridgeRawStateSchema },
    spaceRoomId: { type: String },
    linkedAt: { type: Date, required: true },
    lastStateAt: { type: Date, required: true },
    lastConnectedAt: { type: Date },
    lastNotifiedState: { type: String, enum: BRIDGE_ACCOUNT_STATES },
    lastNotifiedAt: { type: Date },
  },
  { timestamps: true },
);

/**
 * One row per remote login. The bridge's `remote_id` is what the status webhook
 * arrives with, so re-linking the same remote account updates the row it already
 * has rather than growing a second one the user would see twice.
 */
BridgeAccountSchema.index(
  { oxyUserId: 1, network: 1, remoteLoginId: 1 },
  { unique: true },
);
/** The TTL sweep scans by state and staleness (§5.4). */
BridgeAccountSchema.index({ state: 1, lastStateAt: 1 });
/**
 * `GET /internal/bridges/proxy` resolves a slot to its lease through this, on
 * the bridge's connect path — which cannot afford a collection scan. Sparse
 * because only per-user-process networks ever set it.
 */
BridgeAccountSchema.index({ slotId: 1 }, { sparse: true });

export const BridgeAccount = mongoose.model<IBridgeAccount>(
  "BridgeAccount",
  BridgeAccountSchema,
);
export default BridgeAccount;
