/**
 * `bridge_accounts` — one remote account linked through one bridge.
 *
 * Ported from the `BridgeAccount` call sites in `services/bridges/*` and
 * `routes/bridges*.ts`. Nothing imports this yet: the destination lands first so
 * the switch is a diff in which call sites move and the repository does not
 * change underneath them.
 *
 * ## Two Mongo idioms this replaces, and what each becomes
 *
 * `findOneAndUpdate(..., { upsert: true })` becomes `INSERT … ON CONFLICT`
 * against the unique index the model already declared, so re-linking the same
 * remote account converges on the constraint rather than on a service being
 * careful. `$setOnInsert` becomes the ABSENCE of a column from the conflict
 * branch's SET list — a stronger guarantee than the operator, because a column
 * that is not there cannot be written.
 *
 * `$set` with a SPREAD of optional details is the one that does not translate
 * literally, and it is a real port hazard: a key Mongo never receives is a key
 * Mongo never writes, while `excluded.remote_name` is NULL for an absent value
 * and would ERASE the name already on the row. Every optional detail therefore
 * goes through {@link keepUnlessSupplied}. `bridges.realdb.test.ts` pins it,
 * because the failure is silent and surfaces one `whoami` later.
 *
 * ## `raw_state_event` is recorded, never validated
 *
 * The column carries a CHECK nowhere (see `schema/CONVENTIONS.md`), and this
 * module adds none. The bridge's vocabulary is the bridge's; refusing a value
 * this deployment has not caught up with would drop precisely the status update
 * that tells an operator something changed.
 */

import { and, asc, eq, notInArray, sql, type SQL } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { publicColumns } from "@oxyhq/db/assert";
import { qualified, sqlColumnName, type SelectedRow } from "@oxyhq/db";
import type { BridgeNetworkId } from "../../config/bridges";
import type { AlloDatabase } from "../index";
import { PROTECTED_COLUMNS } from "../protectedColumns";
import { bridgeAccounts, type BridgeAccountState } from "../schema/bridges";

/**
 * `bridge_accounts` protects no column today, and this still reads through the
 * registry rather than `.select()`: a bare select returns whatever the table
 * grows next, whereas this one starts withholding a column the moment somebody
 * registers it.
 */
const ACCOUNT_COLUMNS = publicColumns(bridgeAccounts, PROTECTED_COLUMNS);

export type BridgeAccountRow = SelectedRow<typeof ACCOUNT_COLUMNS>;

/**
 * `coalesce(excluded.<col>, bridge_accounts.<col>)` for a conflict branch.
 *
 * Both halves have to be spelled by the casing authority rather than by hand:
 * `column.name` is the TypeScript property name, so `excluded.remoteName` would
 * be a column Postgres has never heard of, and a bare interpolation of the
 * table side renders unqualified — which inside `DO UPDATE SET` is ambiguous
 * with `excluded`.
 */
function keepUnlessSupplied(column: PgColumn): SQL {
  return sql`coalesce(excluded.${sql.identifier(sqlColumnName(column))}, ${qualified(column)})`;
}

/**
 * The remote profile, flattened.
 *
 * The schema chose prefixed columns over `jsonb` because every field is read on
 * its own, so the flattening happens at the edge of the domain — here — rather
 * than in a mapper that would be a second shape to keep in step with the table.
 * A caller that owes a client the nested `remoteProfile` object composes it in
 * the serializer that already owns that contract.
 */
export interface BridgeAccountDetails {
  readonly remoteName?: string;
  readonly spaceRoomId?: string;
  readonly remoteProfileName?: string;
  readonly remoteProfileUsername?: string;
  readonly remoteProfilePhone?: string;
  readonly remoteProfileAvatarUrl?: string;
}

export interface UpsertLinkedAccountInput extends BridgeAccountDetails {
  readonly id: string;
  readonly oxyUserId: string;
  readonly network: BridgeNetworkId;
  readonly remoteLoginId: string;
  readonly at: Date;
}

/**
 * Record a completed login, converging on `(oxy_user_id, network, remote_login_id)`.
 *
 * `linkedAt` is absent from the conflict branch on purpose: it is when this user
 * FIRST linked this remote account, and a re-link is not a new one. `id` is
 * likewise never overwritten, so the caller's freshly minted id is discarded by
 * the database when the row already exists — which is what makes two concurrent
 * completions of one login produce one account rather than a duplicate-key error
 * somebody has to catch.
 */
export async function upsertLinkedAccount(
  db: AlloDatabase,
  input: UpsertLinkedAccountInput,
): Promise<BridgeAccountRow> {
  const rows = await db
    .insert(bridgeAccounts)
    .values({
      id: input.id,
      oxyUserId: input.oxyUserId,
      network: input.network,
      remoteLoginId: input.remoteLoginId,
      state: "connecting",
      linkedAt: input.at,
      lastStateAt: input.at,
      ...detailValues(input),
    })
    .onConflictDoUpdate({
      target: [
        bridgeAccounts.oxyUserId,
        bridgeAccounts.network,
        bridgeAccounts.remoteLoginId,
      ],
      set: {
        state: "connecting",
        lastStateAt: input.at,
        updatedAt: input.at,
        remoteName: keepUnlessSupplied(bridgeAccounts.remoteName),
        spaceRoomId: keepUnlessSupplied(bridgeAccounts.spaceRoomId),
        remoteProfileName: keepUnlessSupplied(bridgeAccounts.remoteProfileName),
        remoteProfileUsername: keepUnlessSupplied(bridgeAccounts.remoteProfileUsername),
        remoteProfilePhone: keepUnlessSupplied(bridgeAccounts.remoteProfilePhone),
        remoteProfileAvatarUrl: keepUnlessSupplied(bridgeAccounts.remoteProfileAvatarUrl),
      },
    })
    .returning(ACCOUNT_COLUMNS);

  const account = rows[0];
  if (!account) throw new Error("bridge account upsert returned no row");
  return account;
}

export interface ReportedStateInput extends BridgeAccountDetails {
  readonly id: string;
  readonly state: BridgeAccountState;
  readonly at: Date;
  /** The bridge's own word for its state, stored verbatim and never checked. */
  readonly rawStateEvent: string;
  readonly rawStateError?: string;
  readonly rawStateMessage?: string;
  readonly rawStateReason?: string;
  readonly rawStateTtl?: number;
}

/**
 * Apply one reported state to the account it is about.
 *
 * The five `raw_state_*` columns are written TOGETHER, absent ones as NULL,
 * because Mongo's `$set: { rawState: {…} }` replaced the whole subdocument — a
 * report that carries no `error` means there is no longer an error, not that the
 * previous one still stands. This is the opposite of the detail columns above,
 * and the difference is the source model's, not a choice made here.
 *
 * Reaching `connected` clears the notification marker and stamps
 * `last_connected_at`. Both writers of this row do exactly that today, in two
 * places, and the rule belongs to the row rather than to whoever is writing it:
 * a third writer that forgot would leave a user who reconnects and is later
 * logged out again permanently un-notifiable, which nothing would report.
 */
export async function applyReportedState(
  db: AlloDatabase,
  input: ReportedStateInput,
): Promise<BridgeAccountRow | undefined> {
  const rows = await db
    .update(bridgeAccounts)
    .set({
      state: input.state,
      lastStateAt: input.at,
      rawStateEvent: input.rawStateEvent,
      rawStateError: input.rawStateError ?? null,
      rawStateMessage: input.rawStateMessage ?? null,
      rawStateReason: input.rawStateReason ?? null,
      rawStateTtl: input.rawStateTtl ?? null,
      rawStateAt: input.at,
      ...detailValues(input),
      ...connectedTransition(input.state, input.at),
    })
    .where(eq(bridgeAccounts.id, input.id))
    .returning(ACCOUNT_COLUMNS);
  return rows[0];
}

export interface ReconcileAccountInput {
  readonly id: string;
  readonly state: BridgeAccountState;
  readonly at: Date;
  readonly remoteName?: string;
  readonly spaceRoomId?: string;
}

/**
 * Reconcile an account from `whoami` — the reconnect route, and what §5.4
 * prescribes for an account that has gone quiet.
 *
 * Distinct from {@link applyReportedState} because it carries no reported state:
 * `whoami` answers what the bridge BELIEVES, not what it last announced, so
 * writing `raw_state_*` here would invent a report no bridge sent. The
 * `connected` transition is shared, for the reason stated there.
 */
export async function reconcileAccount(
  db: AlloDatabase,
  input: ReconcileAccountInput,
): Promise<BridgeAccountRow | undefined> {
  const rows = await db
    .update(bridgeAccounts)
    .set({
      state: input.state,
      lastStateAt: input.at,
      ...detailValues(input),
      ...connectedTransition(input.state, input.at),
    })
    .where(eq(bridgeAccounts.id, input.id))
    .returning(ACCOUNT_COLUMNS);
  return rows[0];
}

/** Records that the user has been told about `state`, so a re-send does not tell them again. */
export async function markAccountNotified(
  db: AlloDatabase,
  input: { readonly id: string; readonly state: BridgeAccountState; readonly at: Date },
): Promise<void> {
  await db
    .update(bridgeAccounts)
    .set({ lastNotifiedState: input.state, lastNotifiedAt: input.at, updatedAt: input.at })
    .where(eq(bridgeAccounts.id, input.id));
}

export interface StaleAccountSweepInput {
  readonly now: Date;
  /** How far past a state's own TTL a bridge may go silent (§5.4). */
  readonly marginSeconds: number;
  /** The TTL to assume for an account whose last report carried none. */
  readonly defaultTtlSeconds: number;
}

/**
 * Mark as `failed` every account whose last state outlived its OWN TTL.
 *
 * Mongo needed an `$expr` aggregation to compare a stored field against a
 * computed deadline; in SQL it is the predicate it always was. The comparison
 * stays per-account rather than against one global age because the TTL is
 * per-state — one hour when the bridge reported an error, six when it did not —
 * and a single fixed age would either declare healthy accounts dead or let
 * broken ones sit green for hours.
 *
 * Both thresholds are the CALLER's: the margin is configuration and the default
 * TTL is the bridge's own healthy default, and neither is a fact about the
 * table. `linking` is excluded because an attempt in progress has no reported
 * state yet and its own expiry governs it; `failed` is excluded so the sweep
 * does not keep rewriting `last_state_at` on accounts it already marked.
 */
export async function markStaleAccountsFailed(
  db: AlloDatabase,
  input: StaleAccountSweepInput,
): Promise<number> {
  const rows = await db
    .update(bridgeAccounts)
    .set({
      state: "failed",
      rawStateReason: "stale",
      lastStateAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        notInArray(bridgeAccounts.state, ["failed", "linking"]),
        // The deadline is bound as an ISO string with an explicit cast, NOT as a
        // `Date`: inside a raw `sql` template there is no column to encode it,
        // and postgres.js's bind path throws `ERR_INVALID_ARG_TYPE` on the
        // object. A runtime failure `tsc` cannot see.
        sql`${bridgeAccounts.lastStateAt} + ((coalesce(${bridgeAccounts.rawStateTtl}, ${input.defaultTtlSeconds}::int) + ${input.marginSeconds}::int) * interval '1 second') < ${input.now.toISOString()}::timestamptz`,
      ),
    )
    .returning({ id: bridgeAccounts.id });
  return rows.length;
}

export async function countAccounts(
  db: AlloDatabase,
  input: { readonly oxyUserId: string; readonly network: BridgeNetworkId },
): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(bridgeAccounts)
    .where(
      and(
        eq(bridgeAccounts.oxyUserId, input.oxyUserId),
        eq(bridgeAccounts.network, input.network),
      ),
    );
  return rows[0]?.total ?? 0;
}

/** This user's linked accounts, oldest link first — and nobody else's. */
export async function listAccountsForUser(
  db: AlloDatabase,
  oxyUserId: string,
): Promise<BridgeAccountRow[]> {
  return await db
    .select(ACCOUNT_COLUMNS)
    .from(bridgeAccounts)
    .where(eq(bridgeAccounts.oxyUserId, oxyUserId))
    .orderBy(asc(bridgeAccounts.linkedAt));
}

/**
 * One account, scoped by `oxyUserId`.
 *
 * The scoping is the point rather than a convenience: §5.1's rule is that an
 * identifier alone is never enough, so there is deliberately no `findAccount(id)`
 * for a route to reach for.
 */
export async function findAccountForUser(
  db: AlloDatabase,
  input: { readonly oxyUserId: string; readonly id: string },
): Promise<BridgeAccountRow | undefined> {
  const rows = await db
    .select(ACCOUNT_COLUMNS)
    .from(bridgeAccounts)
    .where(
      and(eq(bridgeAccounts.oxyUserId, input.oxyUserId), eq(bridgeAccounts.id, input.id)),
    )
    .limit(1);
  return rows[0];
}

/** The status webhook's preferred lookup: the report named the Matrix user. */
export async function findAccountByRemoteLogin(
  db: AlloDatabase,
  input: {
    readonly oxyUserId: string;
    readonly network: BridgeNetworkId;
    readonly remoteLoginId: string;
  },
): Promise<BridgeAccountRow | undefined> {
  const rows = await db
    .select(ACCOUNT_COLUMNS)
    .from(bridgeAccounts)
    .where(
      and(
        eq(bridgeAccounts.oxyUserId, input.oxyUserId),
        eq(bridgeAccounts.network, input.network),
        eq(bridgeAccounts.remoteLoginId, input.remoteLoginId),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * The status webhook's fallback, when the bridge's report carries no `user_id`.
 *
 * Served by `bridge_accounts_network_remote_login_id_idx`, which exists because
 * the unique index starts with `oxy_user_id` and therefore cannot answer this —
 * a sequential scan on the hot path of every state change every bridge reports.
 */
export async function findAccountByNetworkRemoteLogin(
  db: AlloDatabase,
  input: { readonly network: BridgeNetworkId; readonly remoteLoginId: string },
): Promise<BridgeAccountRow | undefined> {
  const rows = await db
    .select(ACCOUNT_COLUMNS)
    .from(bridgeAccounts)
    .where(
      and(
        eq(bridgeAccounts.network, input.network),
        eq(bridgeAccounts.remoteLoginId, input.remoteLoginId),
      ),
    )
    .limit(1);
  return rows[0];
}

export interface SlotOwner {
  readonly oxyUserId: string;
  readonly network: BridgeNetworkId;
}

/**
 * Who a dedicated appservice slot belongs to.
 *
 * Two columns, named, because this runs on the bridge's connect path where a
 * slow or failed answer fails the connection outright — and because the caller
 * needs nothing else in order to find the lease. The `slot_id` index is partial,
 * matching Mongo's `sparse`, so it holds only the rows that could ever match.
 */
export async function findSlotOwner(
  db: AlloDatabase,
  slotId: string,
): Promise<SlotOwner | undefined> {
  const rows = await db
    .select({ oxyUserId: bridgeAccounts.oxyUserId, network: bridgeAccounts.network })
    .from(bridgeAccounts)
    .where(eq(bridgeAccounts.slotId, slotId))
    .limit(1);
  return rows[0];
}

/**
 * Unlink.
 *
 * The proxy lease is deliberately untouched (§8.3 rule 3), which is why nothing
 * here reaches into `bridge_proxy_leases`: coming back to a network has to mean
 * coming back through the same geography.
 */
export async function deleteAccount(db: AlloDatabase, id: string): Promise<boolean> {
  const rows = await db
    .delete(bridgeAccounts)
    .where(eq(bridgeAccounts.id, id))
    .returning({ id: bridgeAccounts.id });
  return rows.length > 0;
}

/** Only the details the caller actually supplied, so an absent one is never written. */
function detailValues(details: BridgeAccountDetails) {
  return {
    ...(details.remoteName === undefined ? {} : { remoteName: details.remoteName }),
    ...(details.spaceRoomId === undefined ? {} : { spaceRoomId: details.spaceRoomId }),
    ...(details.remoteProfileName === undefined
      ? {}
      : { remoteProfileName: details.remoteProfileName }),
    ...(details.remoteProfileUsername === undefined
      ? {}
      : { remoteProfileUsername: details.remoteProfileUsername }),
    ...(details.remoteProfilePhone === undefined
      ? {}
      : { remoteProfilePhone: details.remoteProfilePhone }),
    ...(details.remoteProfileAvatarUrl === undefined
      ? {}
      : { remoteProfileAvatarUrl: details.remoteProfileAvatarUrl }),
  };
}

/** What reaching `connected` does to the row, wherever the state came from. */
function connectedTransition(state: BridgeAccountState, at: Date) {
  if (state !== "connected") return {};
  return { lastConnectedAt: at, lastNotifiedState: null, lastNotifiedAt: null };
}
