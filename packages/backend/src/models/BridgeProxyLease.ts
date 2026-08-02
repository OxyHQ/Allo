import mongoose, { Schema, Document } from "mongoose";
import { BRIDGE_NETWORK_IDS, type BridgeNetworkId } from "../config/bridges";

/**
 * A user's exit geography on one network (docs/matrix/bridges.md §8.2).
 *
 * ## What is guaranteed is the geography, not the IP
 *
 * "Residential" and "the same address for six months" are close to mutually
 * exclusive in the proxy market (§8.1): real residential addresses belong to
 * devices that get switched off, and what is sold as "static residential" is an
 * ISP-registered datacentre address. So the invariant this lease protects is
 * that a user always leaves from the SAME COUNTRY, REGION AND ASN. The concrete
 * address may change, and that is fine — it is what happens to any household
 * when its router renegotiates. What must never happen is Spain on Monday and
 * Germany on Tuesday, because that jump is itself the detection signal.
 *
 * ## No credential is stored here
 *
 * Country, region and a session seed — never the proxy username or password.
 * The URL is composed at the moment it is served, from environment variables. A
 * dump of this collection is therefore not a set of working proxies, and
 * rotating the provider's password is an environment change rather than a data
 * migration.
 */

export const BRIDGE_PROXY_LEASE_STATES = ["active", "quarantined", "released"] as const;
export type BridgeProxyLeaseState = (typeof BRIDGE_PROXY_LEASE_STATES)[number];

/**
 * The only three reasons a lease may move to a different exit (§8.3 rule 4).
 *
 * Deliberately closed. Rotation is the exception here, not the routine: every
 * rotation is a small chance of tripping a verification challenge, so a reason
 * that is not one of these three is a rotation that should not be happening.
 */
export const BRIDGE_PROXY_ROTATION_REASONS = [
  "provider_retired",
  "ban_quarantine",
  "operator_forced",
] as const;
export type BridgeProxyRotationReason = (typeof BRIDGE_PROXY_ROTATION_REASONS)[number];

export interface BridgeProxyRotation {
  at: Date;
  fromSeed: string;
  toSeed: string;
  reason: BridgeProxyRotationReason;
}

export interface BridgeProxyLeaseFields {
  oxyUserId: string;
  /** The lease is per (user, network): one network's ban must not move another's IP. */
  network: BridgeNetworkId;
  /** The provider's identifier — never the vendor's brand name in code (§8.2). */
  provider: string;
  /**
   * ISO 3166-1 alpha-2, decided once and NEVER recalculated (§8.3 rule 2).
   *
   * Not even if the user travels. A user who genuinely emigrates is a support
   * case with a human in it, precisely because the automatic version of that
   * change is indistinguishable from the signal we are trying not to emit.
   */
  countryCode: string;
  regionCode?: string;
  /** Random, stable, and what the provider's sticky session is keyed on. */
  sessionSeed: string;
  state: BridgeProxyLeaseState;

  lastExitIp?: string;
  lastExitCountry?: string;
  lastVerifiedAt?: Date;

  /** Every rotation, ever. The history that gets read when something goes wrong. */
  rotations: BridgeProxyRotation[];

  createdAt: Date;
  updatedAt: Date;
  releasedAt?: Date;
}

export interface LeanBridgeProxyLease extends BridgeProxyLeaseFields {
  _id: mongoose.Types.ObjectId;
}

export interface IBridgeProxyLease
  extends BridgeProxyLeaseFields,
    Document<mongoose.Types.ObjectId> {
  _id: mongoose.Types.ObjectId;
}

const BridgeProxyRotationSchema = new Schema<BridgeProxyRotation>(
  {
    at: { type: Date, required: true },
    fromSeed: { type: String, required: true },
    toSeed: { type: String, required: true },
    reason: { type: String, enum: BRIDGE_PROXY_ROTATION_REASONS, required: true },
  },
  { _id: false },
);

const BridgeProxyLeaseSchema = new Schema<IBridgeProxyLease>(
  {
    oxyUserId: { type: String, required: true },
    network: { type: String, enum: BRIDGE_NETWORK_IDS, required: true },
    provider: { type: String, required: true, maxlength: 100 },
    countryCode: {
      type: String,
      required: true,
      match: [/^[A-Z]{2}$/, "countryCode must be ISO 3166-1 alpha-2"],
    },
    regionCode: { type: String, maxlength: 10 },
    sessionSeed: { type: String, required: true, maxlength: 100 },
    state: {
      type: String,
      enum: BRIDGE_PROXY_LEASE_STATES,
      required: true,
      default: "active",
    },
    lastExitIp: { type: String, maxlength: 64 },
    lastExitCountry: { type: String, maxlength: 2 },
    lastVerifiedAt: { type: Date },
    rotations: { type: [BridgeProxyRotationSchema], default: [] },
    releasedAt: { type: Date },
  },
  { timestamps: true },
);

/**
 * One lease per (user, network) — the index that makes §8.3 rule 7 true.
 *
 * Two users sharing an exit address means one user's ban correlates the other,
 * which is the entire reason per-user proxies exist. A unique index is what
 * turns "the service is careful" into "the database refuses"; without it, two
 * concurrent link requests from the same user race into two leases, and the
 * loser's session seed is the one that silently stops being used.
 */
BridgeProxyLeaseSchema.index({ oxyUserId: 1, network: 1 }, { unique: true });

export const BridgeProxyLease = mongoose.model<IBridgeProxyLease>(
  "BridgeProxyLease",
  BridgeProxyLeaseSchema,
);
export default BridgeProxyLease;
