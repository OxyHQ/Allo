/**
 * `bridge_proxy_leases` and `bridge_proxy_lease_rotations` — a user's exit
 * geography on one network, and the history of every time it moved.
 *
 * Ported from the `BridgeProxyLease` call sites in
 * `services/bridges/proxy/ProxyLeaseService.ts`. Nothing imports it yet.
 *
 * ## Acquisition converges on the constraint
 *
 * `UNIQUE(oxy_user_id, network)` is what makes §8.3 rule 7 — a lease is never
 * shared between users — true, and Mongo could only USE it by racing into it:
 * read, create, catch the duplicate, read again. {@link acquireLease} is one
 * `INSERT … ON CONFLICT DO UPDATE … RETURNING`, so the loser of a race is
 * handed the winner's row by the database rather than by a retry that has to be
 * remembered. There is no read-then-write anywhere in this module's write path.
 *
 * The conflict branch's SET list is the interesting part, and what it does NOT
 * contain is the point: `country_code`, `region_code` and `session_seed` are
 * absent, so §8.3 rule 2 (the country is frozen at creation and never
 * recalculated) and rule 3 (unlinking does not release the lease, so re-linking
 * returns to the same geography) are properties of the statement rather than of
 * a caller checking first. A `released` lease is REVIVED in place, keeping both
 * — releasing is an operational act and does not make the user's home country a
 * different country.
 *
 * ## The rotation history is append-only, and that is why it is a table
 *
 * `rotations[]` was an embedded array, which is what an array is worst at:
 * nothing stops a write replacing the whole thing and erasing the evidence it
 * exists to keep. {@link rotateLease} only ever INSERTs a row, and no function
 * here updates or deletes one. It also closes a race the Mongo version had —
 * reading `sessionSeed` in one query and pushing it as `fromSeed` in another
 * let two concurrent rotations record the same predecessor — by taking the row
 * lock and reading the seed under it, in one transaction with the swap.
 *
 * ## Two protected columns, and only one of them is reachable
 *
 * `session_seed` and `last_exit_ip` are the egress identity. The seed is
 * genuinely needed — a proxy URL cannot be composed without it — so it is named
 * explicitly, in one place. `last_exit_ip` is only ever WRITTEN, so no read here
 * returns it, and the rotation reads withhold both seeds.
 */

import { and, asc, eq, sql } from "drizzle-orm";
import { publicColumns } from "@oxyhq/db/assert";
import type { SelectedRow } from "@oxyhq/db";
import type { BridgeNetworkId } from "../../config/bridges";
import type { AlloDatabase } from "../index";
import { PROTECTED_COLUMNS } from "../protectedColumns";
import {
  bridgeProxyLeaseRotations,
  bridgeProxyLeases,
  type BridgeProxyRotationReason,
} from "../schema/bridges";

/**
 * The lease as the proxy allocator needs it: every public column plus
 * `session_seed`, which the provider's sticky session is keyed on and without
 * which no URL can be composed.
 *
 * `last_exit_ip` stays withheld. It is written by {@link recordLeaseExit} and
 * read by nothing, which is the right shape for a value that ties a user to a
 * network location — so this row cannot leak one however it is serialized.
 */
const LEASE_COLUMNS = {
  ...publicColumns(bridgeProxyLeases, PROTECTED_COLUMNS),
  sessionSeed: bridgeProxyLeases.sessionSeed,
};

/** Rotation evidence WITHOUT the seeds: when the exit identity changed, and why. */
const ROTATION_COLUMNS = publicColumns(bridgeProxyLeaseRotations, PROTECTED_COLUMNS);

export type BridgeProxyLeaseRow = SelectedRow<typeof LEASE_COLUMNS>;
export type BridgeProxyLeaseRotationRow = SelectedRow<typeof ROTATION_COLUMNS>;

export interface AcquireLeaseInput {
  /** Used only if the lease does not exist yet; discarded by the database if it does. */
  readonly id: string;
  readonly oxyUserId: string;
  readonly network: BridgeNetworkId;
  /** The provider's identifier — never the vendor's brand name (§8.2). */
  readonly provider: string;
  /** ISO 3166-1 alpha-2, and CHECK-enforced as such. */
  readonly countryCode: string;
  readonly regionCode?: string;
  /** Random, unguessable, 128 bits. Only reaches the row on a genuine create. */
  readonly sessionSeed: string;
  readonly at: Date;
}

export interface AcquiredLease {
  readonly lease: BridgeProxyLeaseRow;
  /**
   * Whether this call is the one that created the row.
   *
   * `false` covers both "somebody else got there first" and "it has existed for
   * months", which is correct: the caller wanted a lease and there is exactly
   * one. It exists so the create can be LOGGED once rather than on every link
   * attempt, not so a caller can branch on it.
   */
  readonly created: boolean;
}

/**
 * The lease for this (user, network), creating it if there is none.
 *
 * One statement, always. The three outcomes it produces:
 *
 * - no row  → the caller's country and seed are stored, `state` is `active`;
 * - `released` row → revived to `active` with `released_at` cleared, keeping the
 *   country and the seed it already had;
 * - any other row → returned exactly as it stands, including a `quarantined`
 *   one. Quarantine is a decision about a lease we no longer trust, and an
 *   acquisition must not quietly undo it.
 *
 * The conflict branch runs even when it changes nothing, which costs one dead
 * tuple per acquisition on the common path. That is the price of a single
 * statement that always RETURNS the row; `DO UPDATE … WHERE` would return
 * nothing on that same common path and force a follow-up SELECT — the
 * read-then-write this exists to avoid. `updated_at` is guarded by the same
 * predicate as the revival, so a no-op acquisition leaves it where it was.
 */
export async function acquireLease(
  db: AlloDatabase,
  input: AcquireLeaseInput,
): Promise<AcquiredLease> {
  const wasReleased = sql`${bridgeProxyLeases.state} = 'released'`;
  /**
   * Bound as an ISO string with an explicit cast, NOT as a `Date`.
   *
   * A `Date` handed to `.set({ updatedAt })` is encoded by the column's own
   * driver mapper; the same `Date` interpolated into a raw `sql` template has no
   * column to be mapped by, and postgres.js's bind path then throws
   * `ERR_INVALID_ARG_TYPE: … Received an instance of Date`. Measured against a
   * real server — it is a runtime failure `tsc` cannot see, and it is invisible
   * in any test whose writes go through plain column values.
   */
  const at = sql`${input.at.toISOString()}::timestamptz`;
  const rows = await db
    .insert(bridgeProxyLeases)
    .values({
      id: input.id,
      oxyUserId: input.oxyUserId,
      network: input.network,
      provider: input.provider,
      countryCode: input.countryCode,
      ...(input.regionCode === undefined ? {} : { regionCode: input.regionCode }),
      sessionSeed: input.sessionSeed,
      state: "active",
    })
    .onConflictDoUpdate({
      target: [bridgeProxyLeases.oxyUserId, bridgeProxyLeases.network],
      set: {
        state: sql`case when ${wasReleased} then 'active' else ${bridgeProxyLeases.state} end`,
        releasedAt: sql`case when ${wasReleased} then null else ${bridgeProxyLeases.releasedAt} end`,
        updatedAt: sql`case when ${wasReleased} then ${at} else ${bridgeProxyLeases.updatedAt} end`,
      },
    })
    .returning(LEASE_COLUMNS);

  const lease = rows[0];
  if (!lease) throw new Error("bridge proxy lease acquisition returned no row");
  return { lease, created: lease.id === input.id };
}

/** The lease for this (user, network), or nothing. Never creates one. */
export async function findLease(
  db: AlloDatabase,
  input: { readonly oxyUserId: string; readonly network: BridgeNetworkId },
): Promise<BridgeProxyLeaseRow | undefined> {
  const rows = await db
    .select(LEASE_COLUMNS)
    .from(bridgeProxyLeases)
    .where(
      and(
        eq(bridgeProxyLeases.oxyUserId, input.oxyUserId),
        eq(bridgeProxyLeases.network, input.network),
      ),
    )
    .limit(1);
  return rows[0];
}

export interface RecordLeaseExitInput {
  readonly id: string;
  readonly observedIp: string;
  /** Uppercased by the caller, so it can be compared against `country_code` by eye. */
  readonly observedCountry: string;
  readonly at: Date;
  /**
   * `true` records the observation AND moves the lease to `quarantined` — the
   * mismatch path (§8.3 rule 5). Quarantining rather than rotating is
   * deliberate: an exit from an unexpected country is evidence that the
   * provider's configuration is not what we think it is, and silently taking a
   * new session from the same provider would paper over exactly that fault.
   */
  readonly quarantine: boolean;
}

/**
 * Record where the proxy actually came out.
 *
 * The observation is stored on BOTH paths, including the mismatch, because the
 * country that was not expected is the one worth having on the row during an
 * incident.
 */
export async function recordLeaseExit(
  db: AlloDatabase,
  input: RecordLeaseExitInput,
): Promise<BridgeProxyLeaseRow | undefined> {
  const rows = await db
    .update(bridgeProxyLeases)
    .set({
      lastExitIp: input.observedIp,
      lastExitCountry: input.observedCountry,
      lastVerifiedAt: input.at,
      updatedAt: input.at,
      ...(input.quarantine ? { state: "quarantined" as const } : {}),
    })
    .where(eq(bridgeProxyLeases.id, input.id))
    .returning(LEASE_COLUMNS);
  return rows[0];
}

export interface RotateLeaseInput {
  readonly oxyUserId: string;
  readonly network: BridgeNetworkId;
  /** Id for the rotation row. Every rotation is a new row; none is ever reused. */
  readonly rotationId: string;
  readonly toSeed: string;
  readonly reason: BridgeProxyRotationReason;
  readonly at: Date;
}

export interface RotatedLease {
  readonly lease: BridgeProxyLeaseRow;
  readonly rotation: BridgeProxyLeaseRotationRow;
}

/**
 * Move a lease to a new session within the SAME country (§8.3 rule 4).
 *
 * `country_code` and `region_code` are untouched by construction — they are not
 * in the SET list, so a rotation cannot move a user's geography however it is
 * called. The lease also returns to `active`, which is what makes rotation the
 * remedy for a quarantine.
 *
 * The transaction is not decoration. `from_seed` must be the seed the row
 * ACTUALLY held at the instant of the swap, so it is read under `FOR UPDATE` in
 * the same transaction that writes the replacement; two concurrent rotations
 * then serialize into a chain, each naming its true predecessor, instead of both
 * recording the same one and leaving a gap in the evidence.
 *
 * `undefined` means there was no lease to rotate.
 */
export async function rotateLease(
  db: AlloDatabase,
  input: RotateLeaseInput,
): Promise<RotatedLease | undefined> {
  return await db.transaction(async (tx) => {
    const locked = await tx
      .select({ id: bridgeProxyLeases.id, sessionSeed: bridgeProxyLeases.sessionSeed })
      .from(bridgeProxyLeases)
      .where(
        and(
          eq(bridgeProxyLeases.oxyUserId, input.oxyUserId),
          eq(bridgeProxyLeases.network, input.network),
        ),
      )
      .limit(1)
      .for("update");

    const current = locked[0];
    if (!current) return undefined;

    const rotationRows = await tx
      .insert(bridgeProxyLeaseRotations)
      .values({
        id: input.rotationId,
        leaseId: current.id,
        rotatedAt: input.at,
        fromSeed: current.sessionSeed,
        toSeed: input.toSeed,
        reason: input.reason,
      })
      .returning(ROTATION_COLUMNS);

    const leaseRows = await tx
      .update(bridgeProxyLeases)
      .set({ sessionSeed: input.toSeed, state: "active", updatedAt: input.at })
      .where(eq(bridgeProxyLeases.id, current.id))
      .returning(LEASE_COLUMNS);

    const rotation = rotationRows[0];
    const lease = leaseRows[0];
    if (!rotation || !lease) throw new Error("bridge proxy lease rotation returned no row");
    return { lease, rotation };
  });
}

/**
 * Every rotation this lease has ever had, oldest first — the record that gets
 * read when somebody asks why this user's accounts keep being challenged.
 *
 * Without the seeds: what an operator needs is WHEN the exit identity changed
 * and WHY, and the seeds are the identity itself.
 */
export async function listLeaseRotations(
  db: AlloDatabase,
  leaseId: string,
): Promise<BridgeProxyLeaseRotationRow[]> {
  return await db
    .select(ROTATION_COLUMNS)
    .from(bridgeProxyLeaseRotations)
    .where(eq(bridgeProxyLeaseRotations.leaseId, leaseId))
    .orderBy(asc(bridgeProxyLeaseRotations.rotatedAt));
}
