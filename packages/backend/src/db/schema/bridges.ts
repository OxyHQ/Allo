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

/**
 * Narrows a string the bridge sent to a state event it declares.
 *
 * Beside the tuple, so the guard and the vocabulary cannot drift. Note what it
 * is NOT beside: `raw_state_event` carries no CHECK, deliberately — the bridge's
 * vocabulary is the bridge's, and refusing a value this deployment has not
 * caught up with would drop precisely the status update telling an operator
 * something changed. This guard is how `bridgeStateMapping` decides what a
 * KNOWN event means; an unknown one is still recorded.
 */
export function isBridgeStateEvent(value: string): value is BridgeStateEvent {
  return (BRIDGE_STATE_EVENTS as readonly string[]).includes(value);
}

export const BRIDGE_LOGIN_STEP_TYPES = [
  "user_input",
  "cookies",
  "client_http",
  "display_and_wait",
  "webauthn",
  "complete",
] as const;
export type BridgeLoginStepType = (typeof BRIDGE_LOGIN_STEP_TYPES)[number];

/**
 * Narrows a step type the bridge sent. Beside the tuple that renders
 * `bridge_link_sessions_current_step_type_check`, so the guard, the TypeScript
 * union and the database constraint are three views of one list.
 */
export function isBridgeLoginStepType(value: string): value is BridgeLoginStepType {
  return (BRIDGE_LOGIN_STEP_TYPES as readonly string[]).includes(value);
}

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
    /**
     * The four remote-profile columns and the three `raw_state_*` text columns
     * carried Mongoose `maxlength` bounds (200, 200, 50, 2 000 and 200, 1 000,
     * 200) and NONE of them is a CHECK here — because none of those bounds ever
     * ran. There is no `BridgeAccount.create()` in this service outside its own
     * tests: every write is `updateOne`, `findOneAndUpdate` or `updateMany`, and
     * Mongoose does not run validators on those without `runValidators: true`,
     * which appears nowhere.
     *
     * That makes reviving them a NEW restriction on values this table has always
     * stored — and they are the least suitable values to restrict, because they
     * come from the remote network. A WhatsApp display name over 200 characters
     * or a Telegram avatar URL over 2 000 would start failing an account write
     * that has succeeded for as long as the feature has existed, and the failure
     * would surface as a bridge that silently stops updating.
     */
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
 * The Mongoose `maxlength` bounds that were ACTUALLY IN FORCE, and only those.
 *
 * Mongoose runs a `maxlength` validator on `.create()`/`.save()` and NOT on
 * `updateOne`/`findOneAndUpdate`/`updateMany` unless `runValidators: true` —
 * which appears nowhere in this repository. So of the sixteen bounds the three
 * bridge models declared, only these five ever refused a value: the three
 * written by `BridgeLinkSession.create` and the two written by
 * `BridgeProxyLease.create`.
 *
 * The other eleven are listed on their columns below with the reason they get no
 * CHECK. Reviving a bound that never held would be a restriction this port
 * invented, and the values behind most of them come from a remote network — a
 * WhatsApp display name over 200 characters would start failing an account write
 * that has always succeeded.
 */
export const MAX_LINK_SESSION_FLOW_ID_LENGTH = 200;
export const MAX_LINK_SESSION_PROCESS_ID_LENGTH = 200;
export const MAX_LINK_SESSION_STEP_ID_LENGTH = 200;
export const MAX_PROXY_LEASE_PROVIDER_LENGTH = 100;
export const MAX_PROXY_LEASE_SESSION_SEED_LENGTH = 100;

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
    /**
     * `maxlength: 200` in Mongoose, and NO CHECK here: it is written only by an
     * update, so the validator never ran on it. The value is the bridge's own
     * error code.
     */
    failureCode: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("bridge_link_sessions_expires_at_idx").on(t.expiresAt),
    checkOneOf("bridge_link_sessions_network_check", t.network, BRIDGE_NETWORK_IDS),
    checkOneOf(
      "bridge_link_sessions_current_step_type_check",
      t.currentStepType,
      BRIDGE_LOGIN_STEP_TYPES,
    ),
    checkOneOf("bridge_link_sessions_outcome_check", t.outcome, BRIDGE_LINK_OUTCOMES),
    /**
     * `sql.raw` for each bound, so the constant is rendered as migration TEXT.
     * Interpolating it normally writes a bound-parameter placeholder (`$1`) into
     * the generated DDL, which generates cleanly and fails at APPLY time.
     *
     * `current_step_id` is also written by an UPDATE, which the validator never
     * covered — but it carries the same value from the same source as the create
     * that did, so a step id too long to store was already refused at the moment
     * the session was opened.
     */
    check(
      "bridge_link_sessions_flow_id_length_check",
      sql.raw(`length(flow_id) <= ${MAX_LINK_SESSION_FLOW_ID_LENGTH}`),
    ),
    check(
      "bridge_link_sessions_remote_login_process_id_length_check",
      sql.raw(`length(remote_login_process_id) <= ${MAX_LINK_SESSION_PROCESS_ID_LENGTH}`),
    ),
    check(
      "bridge_link_sessions_current_step_id_length_check",
      sql.raw(`length(current_step_id) <= ${MAX_LINK_SESSION_STEP_ID_LENGTH}`),
    ),
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
    /**
     * `maxlength: 10` in Mongoose, and NO CHECK here — this column has no writer
     * at all. `ProxyLeaseService` reads it when composing a provider URL and
     * nothing has ever set it, so the validator never saw a value either.
     */
    regionCode: text(),
    sessionSeed: text().notNull(),
    state: text({ enum: BRIDGE_PROXY_LEASE_STATES }).notNull().default("active"),
    /**
     * `maxlength: 64` and `maxlength: 2` in Mongoose, and NO CHECKs here: both
     * are written only by updates, so neither bound ever ran. They hold what the
     * proxy's echo endpoint reported, and a CHECK would turn a vendor answering
     * `USA` into a failed lease verification rather than the mismatch it is.
     */
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
    /** Both written by `BridgeProxyLease.create`, so both bounds were in force. */
    check(
      "bridge_proxy_leases_provider_length_check",
      sql.raw(`length(provider) <= ${MAX_PROXY_LEASE_PROVIDER_LENGTH}`),
    ),
    check(
      "bridge_proxy_leases_session_seed_length_check",
      sql.raw(`length(session_seed) <= ${MAX_PROXY_LEASE_SESSION_SEED_LENGTH}`),
    ),
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
