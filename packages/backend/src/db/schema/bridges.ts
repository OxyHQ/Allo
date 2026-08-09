/**
 * Matrix bridge state: linked accounts, in-flight link sessions and proxy leases.
 *
 * Ported from `models/BridgeAccount.ts`, `models/BridgeLinkSession.ts` and
 * `models/BridgeProxyLease.ts`. `BRIDGE_NETWORK_IDS` is NOT redeclared here — it
 * is imported from `config/bridges.ts`, which is the same tuple the routes, the
 * services and the Mongoose models already validate against. A second copy is
 * the one way a network can be addable in one layer and rejected in another.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, updatedAt } from "@oxyhq/db";
import { BRIDGE_NETWORK_IDS } from "../../config/bridges";
import { checkOneOf } from "./columns";

export const BRIDGE_ACCOUNT_STATES = [
  "linking",
  "connecting",
  "connected",
  "degraded",
  "action_required",
  "failed",
] as const;
export type BridgeAccountState = (typeof BRIDGE_ACCOUNT_STATES)[number];

/**
 * The bridge's own vocabulary, echoed back verbatim, plus `UNKNOWN` for a value
 * this deployment has not caught up with. Mongoose declared the field `String`
 * with NO enum for exactly that reason, so there is no CHECK on it here either:
 * refusing an unrecognised state would drop the status update that tells an
 * operator something changed.
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

export const BRIDGE_LOGIN_STEP_TYPES = [
  "user_input",
  "cookies",
  "client_http",
  "display_and_wait",
  "webauthn",
  "complete",
] as const;
export type BridgeLoginStepType = (typeof BRIDGE_LOGIN_STEP_TYPES)[number];

export const BRIDGE_LINK_OUTCOMES = [
  "pending",
  "completed",
  "cancelled",
  "expired",
  "failed",
] as const;
export type BridgeLinkOutcome = (typeof BRIDGE_LINK_OUTCOMES)[number];

export const BRIDGE_PROXY_LEASE_STATES = ["active", "quarantined", "released"] as const;
export type BridgeProxyLeaseState = (typeof BRIDGE_PROXY_LEASE_STATES)[number];

export const BRIDGE_PROXY_ROTATION_REASONS = [
  "provider_retired",
  "ban_quarantine",
  "operator_forced",
] as const;
export type BridgeProxyRotationReason = (typeof BRIDGE_PROXY_ROTATION_REASONS)[number];

/**
 * One remote account linked through one bridge.
 *
 * The embedded `remoteProfile` and `rawState` become prefixed columns: both are
 * fixed-shape and both are read field by field (a name to display, a state event
 * to decide whether to notify), which is the case `jsonb` is wrong for.
 */
export const bridgeAccounts = pgTable(
  "bridge_accounts",
  {
    id: text().primaryKey(),
    oxyUserId: text().notNull(),
    network: text({ enum: BRIDGE_NETWORK_IDS }).notNull(),
    remoteLoginId: text().notNull(),
    remoteName: text(),
    remoteProfileName: text(),
    remoteProfileUsername: text(),
    remoteProfilePhone: text(),
    remoteProfileAvatarUrl: text(),
    slotId: text(),
    state: text({ enum: BRIDGE_ACCOUNT_STATES }).notNull().default("linking"),
    rawStateEvent: text(),
    rawStateError: text(),
    rawStateMessage: text(),
    rawStateReason: text(),
    rawStateTtl: integer(),
    rawStateAt: timestamptz(),
    spaceRoomId: text(),
    linkedAt: timestamptz().notNull(),
    lastStateAt: timestamptz().notNull(),
    lastConnectedAt: timestamptz(),
    lastNotifiedState: text({ enum: BRIDGE_ACCOUNT_STATES }),
    lastNotifiedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bridge_accounts_oxy_user_id_network_remote_login_id_key").on(
      t.oxyUserId,
      t.network,
      t.remoteLoginId,
    ),
    index("bridge_accounts_oxy_user_id_idx").on(t.oxyUserId),
    index("bridge_accounts_state_last_state_at_idx").on(t.state, t.lastStateAt),
    index("bridge_accounts_network_remote_login_id_idx").on(t.network, t.remoteLoginId),
    /**
     * Partial, matching Mongo's `sparse: true`. A plain index would carry a row
     * for every account without a slot, which is most of them.
     */
    index("bridge_accounts_slot_id_idx")
      .on(t.slotId)
      .where(sql`${t.slotId} is not null`),
    checkOneOf("bridge_accounts_network_check", t.network, BRIDGE_NETWORK_IDS),
    checkOneOf("bridge_accounts_state_check", t.state, BRIDGE_ACCOUNT_STATES),
    checkOneOf(
      "bridge_accounts_last_notified_state_check",
      t.lastNotifiedState,
      BRIDGE_ACCOUNT_STATES,
    ),
    check("bridge_accounts_raw_state_ttl_check", sql`${t.rawStateTtl} >= 0`),
  ],
);

/**
 * An in-flight linking attempt.
 *
 * `resultAccountId` was a bare `ObjectId` with no `ref` — a pointer Mongo never
 * checked. It becomes a real foreign key with `ON DELETE SET NULL`: the session
 * is a historical record of an attempt and must survive the account it produced
 * being unlinked, but it must not point at an account that no longer exists.
 *
 * TTL in Mongo, {@link import('../expiry').EXPIRY_SWEEP_TARGETS} here.
 */
export const bridgeLinkSessions = pgTable(
  "bridge_link_sessions",
  {
    id: text().primaryKey(),
    linkId: text().notNull().unique("bridge_link_sessions_link_id_key"),
    oxyUserId: text().notNull(),
    network: text({ enum: BRIDGE_NETWORK_IDS }).notNull(),
    flowId: text().notNull(),
    slotId: text(),
    remoteLoginProcessId: text().notNull(),
    currentStepId: text(),
    currentStepType: text({ enum: BRIDGE_LOGIN_STEP_TYPES }),
    expiresAt: timestamptz().notNull(),
    outcome: text({ enum: BRIDGE_LINK_OUTCOMES }).notNull().default("pending"),
    resultAccountId: text().references(() => bridgeAccounts.id, { onDelete: "set null" }),
    failureCode: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bridge_link_sessions_oxy_user_id_network_outcome_idx").on(
      t.oxyUserId,
      t.network,
      t.outcome,
    ),
    index("bridge_link_sessions_expires_at_idx").on(t.expiresAt),
    checkOneOf("bridge_link_sessions_network_check", t.network, BRIDGE_NETWORK_IDS),
    checkOneOf(
      "bridge_link_sessions_current_step_type_check",
      t.currentStepType,
      BRIDGE_LOGIN_STEP_TYPES,
    ),
    checkOneOf("bridge_link_sessions_outcome_check", t.outcome, BRIDGE_LINK_OUTCOMES),
  ],
);

/** One egress identity held for one user on one network. */
export const bridgeProxyLeases = pgTable(
  "bridge_proxy_leases",
  {
    id: text().primaryKey(),
    oxyUserId: text().notNull(),
    network: text({ enum: BRIDGE_NETWORK_IDS }).notNull(),
    provider: text().notNull(),
    countryCode: text().notNull(),
    regionCode: text(),
    sessionSeed: text().notNull(),
    state: text({ enum: BRIDGE_PROXY_LEASE_STATES }).notNull().default("active"),
    lastExitIp: text(),
    lastExitCountry: text(),
    lastVerifiedAt: timestamptz(),
    releasedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("bridge_proxy_leases_oxy_user_id_network_key").on(t.oxyUserId, t.network),
    checkOneOf("bridge_proxy_leases_network_check", t.network, BRIDGE_NETWORK_IDS),
    checkOneOf("bridge_proxy_leases_state_check", t.state, BRIDGE_PROXY_LEASE_STATES),
    /** Mongoose's `match: /^[A-Z]{2}$/`, kept as a constraint rather than a convention. */
    check("bridge_proxy_leases_country_code_check", sql`${t.countryCode} ~ '^[A-Z]{2}$'`),
  ],
);

/**
 * The rotation history of a lease, as a CHILD TABLE.
 *
 * This one is append-only evidence — when an exit identity changed and why —
 * which is exactly what an embedded array is worst at: nothing stops a write
 * replacing the whole array and erasing the history it exists to keep.
 */
export const bridgeProxyLeaseRotations = pgTable(
  "bridge_proxy_lease_rotations",
  {
    id: text().primaryKey(),
    leaseId: text()
      .notNull()
      .references(() => bridgeProxyLeases.id, { onDelete: "cascade" }),
    rotatedAt: timestamptz().notNull(),
    fromSeed: text().notNull(),
    toSeed: text().notNull(),
    reason: text({ enum: BRIDGE_PROXY_ROTATION_REASONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("bridge_proxy_lease_rotations_lease_id_rotated_at_idx").on(t.leaseId, t.rotatedAt),
    checkOneOf(
      "bridge_proxy_lease_rotations_reason_check",
      t.reason,
      BRIDGE_PROXY_ROTATION_REASONS,
    ),
  ],
);
