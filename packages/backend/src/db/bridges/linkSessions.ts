/**
 * `bridge_link_sessions` — one login attempt in progress.
 *
 * Ported from the `BridgeLinkSession` call sites in `services/bridges/
 * BridgeLinkService.ts` and `routes/bridges.ts`. Nothing imports it yet.
 *
 * ## The sweep is retention; expiry is a QUERY's business
 *
 * Mongo reaped these rows with a TTL index, and `src/db/expiry.ts` reproduces
 * that. Neither reaps promptly: Mongo's TTL monitor runs on an interval and the
 * sweep runs when its caller runs it, so an attempt past `expires_at` is
 * readable for a while afterwards under both. A read that assumed otherwise
 * would be wrong on both databases — it just happens to be a port that makes
 * somebody think about it. There is deliberately no deletion path here; the
 * registry owns that, and a second one would race it.
 *
 * The two reads below therefore differ ON PURPOSE, and the difference is the
 * whole reason they are two functions:
 *
 * - {@link findLinkSessionForUser} answers "WHICH attempt is this?" and does not
 *   filter, so the caller can tell an expired attempt (410) from one that never
 *   existed (404). Filtering here would collapse those into "no such attempt",
 *   which is exactly the distinction the `expired` outcome exists to preserve.
 * - {@link findOpenLinkSessions} answers "does this user have an attempt OPEN?"
 *   and filters on both `outcome` and `expires_at`, because a `pending` row past
 *   its deadline is not open — the remote login process behind it is gone.
 *
 * ## Nothing the user typed is ever written here
 *
 * Not the phone number, not the six-digit code, not the 2FA password: the model
 * this is ported from holds the SHAPE of the conversation and no answer in it,
 * and no function below takes one.
 */

import { and, asc, eq, gt } from "drizzle-orm";
import { publicColumns } from "@oxyhq/db/assert";
import type { SelectedRow } from "@oxyhq/db";
import type { BridgeNetworkId } from "../../config/bridges";
import type { AlloDatabase } from "../index";
import { PROTECTED_COLUMNS } from "../protectedColumns";
import {
  bridgeLinkSessions,
  type BridgeLinkOutcome,
  type BridgeLoginStepType,
} from "../schema/bridges";

/**
 * Everything a caller may see. `remote_login_process_id` and `current_step_id`
 * are withheld — possession of either lets a caller drive somebody else's
 * half-finished linking flow.
 */
const SESSION_PUBLIC_COLUMNS = publicColumns(bridgeLinkSessions, PROTECTED_COLUMNS);

/**
 * The public columns PLUS the two protected handles, named here so the opt-in is
 * greppable rather than implicit.
 *
 * Relaying the next answer to the bridge is impossible without both, so this is
 * a legitimate need and not a shortcut — but it is also the ONLY one, which is
 * why the columns are added in exactly one place and why the row this produces
 * must never be handed to a serializer.
 */
const SESSION_RELAY_COLUMNS = {
  ...SESSION_PUBLIC_COLUMNS,
  remoteLoginProcessId: bridgeLinkSessions.remoteLoginProcessId,
  currentStepId: bridgeLinkSessions.currentStepId,
};

export type BridgeLinkSessionRow = SelectedRow<typeof SESSION_PUBLIC_COLUMNS>;

/** Carries the bridge's login-process handle. Internal only — see above. */
export type BridgeLinkSessionRelayRow = SelectedRow<typeof SESSION_RELAY_COLUMNS>;

export interface InsertLinkSessionInput {
  readonly id: string;
  /** Opaque and unguessable. The only identifier a client ever sees. */
  readonly linkId: string;
  readonly oxyUserId: string;
  readonly network: BridgeNetworkId;
  readonly flowId: string;
  readonly slotId?: string;
  readonly remoteLoginProcessId: string;
  readonly currentStepId?: string;
  readonly currentStepType?: BridgeLoginStepType;
  readonly expiresAt: Date;
}

/**
 * Open an attempt.
 *
 * A plain insert with no conflict handling: `link_id` is unique, and a collision
 * on it would mean the caller's randomness failed. That must surface as the
 * unique violation it is rather than silently converge on somebody else's
 * attempt.
 */
export async function insertLinkSession(
  db: AlloDatabase,
  input: InsertLinkSessionInput,
): Promise<BridgeLinkSessionRelayRow> {
  const rows = await db
    .insert(bridgeLinkSessions)
    .values({
      id: input.id,
      linkId: input.linkId,
      oxyUserId: input.oxyUserId,
      network: input.network,
      flowId: input.flowId,
      ...(input.slotId === undefined ? {} : { slotId: input.slotId }),
      remoteLoginProcessId: input.remoteLoginProcessId,
      ...(input.currentStepId === undefined ? {} : { currentStepId: input.currentStepId }),
      ...(input.currentStepType === undefined
        ? {}
        : { currentStepType: input.currentStepType }),
      expiresAt: input.expiresAt,
      outcome: "pending",
    })
    .returning(SESSION_RELAY_COLUMNS);

  const session = rows[0];
  if (!session) throw new Error("bridge link session insert returned no row");
  return session;
}

/**
 * One attempt, scoped by `oxyUserId` — the link id alone is never enough (§5.1).
 *
 * Deliberately UNFILTERED by `expires_at`: the caller has to be able to answer
 * "this attempt expired" rather than "no such attempt", and it is the caller
 * that owns that distinction because it also owns the status code. Every caller
 * must check `expiresAt` against its own clock; the row carries it for exactly
 * that purpose.
 *
 * Returns the relay row, because the one thing a caller does with an attempt is
 * relay the next answer to the bridge.
 */
export async function findLinkSessionForUser(
  db: AlloDatabase,
  input: { readonly oxyUserId: string; readonly linkId: string },
): Promise<BridgeLinkSessionRelayRow | undefined> {
  if (input.linkId.length === 0) return undefined;
  const rows = await db
    .select(SESSION_RELAY_COLUMNS)
    .from(bridgeLinkSessions)
    .where(
      and(
        eq(bridgeLinkSessions.oxyUserId, input.oxyUserId),
        eq(bridgeLinkSessions.linkId, input.linkId),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * The attempts this user still has open on a network, oldest first.
 *
 * The question `bridge_link_sessions_oxy_user_id_network_outcome_idx` exists to
 * serve, and the read where a lagging sweep would change the ANSWER rather than
 * merely the row count — so `expires_at` is part of the predicate and not left
 * to the reaper. Public columns only: knowing an attempt is open needs no
 * ability to drive it.
 */
export async function findOpenLinkSessions(
  db: AlloDatabase,
  input: {
    readonly oxyUserId: string;
    readonly network: BridgeNetworkId;
    readonly now: Date;
  },
): Promise<BridgeLinkSessionRow[]> {
  return await db
    .select(SESSION_PUBLIC_COLUMNS)
    .from(bridgeLinkSessions)
    .where(
      and(
        eq(bridgeLinkSessions.oxyUserId, input.oxyUserId),
        eq(bridgeLinkSessions.network, input.network),
        eq(bridgeLinkSessions.outcome, "pending"),
        gt(bridgeLinkSessions.expiresAt, input.now),
      ),
    )
    .orderBy(asc(bridgeLinkSessions.createdAt));
}

/**
 * Move an attempt on to its next step, with the deadline that step earns.
 *
 * `expiresAt` is required rather than optional because every step recomputes it:
 * a `display_and_wait` step lives about as long as the code inside it, and
 * carrying the previous step's deadline forward is how a session comes to claim
 * it outlives a QR that already refreshed.
 */
export async function recordLinkSessionStep(
  db: AlloDatabase,
  input: {
    readonly id: string;
    readonly currentStepId: string;
    readonly currentStepType: BridgeLoginStepType;
    readonly expiresAt: Date;
    readonly at: Date;
  },
): Promise<BridgeLinkSessionRow | undefined> {
  const rows = await db
    .update(bridgeLinkSessions)
    .set({
      currentStepId: input.currentStepId,
      currentStepType: input.currentStepType,
      expiresAt: input.expiresAt,
      updatedAt: input.at,
    })
    .where(eq(bridgeLinkSessions.id, input.id))
    .returning(SESSION_PUBLIC_COLUMNS);
  return rows[0];
}

/**
 * Close an attempt as completed, naming the account it produced.
 *
 * `resultAccountId` is a real foreign key here where Mongo had a bare
 * `ObjectId` nothing checked, so the account must already exist — which it does:
 * the login is recorded before the session is closed. `ON DELETE SET NULL` is
 * what lets the session outlive an unlink, as a record of an ATTEMPT, without
 * pointing at an account that is gone.
 */
export async function completeLinkSession(
  db: AlloDatabase,
  input: {
    readonly id: string;
    readonly currentStepId: string;
    readonly resultAccountId: string;
    readonly at: Date;
  },
): Promise<BridgeLinkSessionRow | undefined> {
  const rows = await db
    .update(bridgeLinkSessions)
    .set({
      currentStepId: input.currentStepId,
      currentStepType: "complete",
      outcome: "completed",
      resultAccountId: input.resultAccountId,
      updatedAt: input.at,
    })
    .where(eq(bridgeLinkSessions.id, input.id))
    .returning(SESSION_PUBLIC_COLUMNS);
  return rows[0];
}

/**
 * Close an attempt that did not complete.
 *
 * One function for `cancelled`, `expired` and `failed` because they differ only
 * in which of them happened; `completed` is separate because it alone carries an
 * account. `failureCode` is the bridge's own error code and never user input —
 * it is optional rather than absent so that `failed`, which the outcome tuple
 * already admits, is reachable at all.
 */
export async function closeLinkSession(
  db: AlloDatabase,
  input: {
    readonly id: string;
    readonly outcome: Exclude<BridgeLinkOutcome, "pending" | "completed">;
    readonly failureCode?: string;
    readonly at: Date;
  },
): Promise<BridgeLinkSessionRow | undefined> {
  const rows = await db
    .update(bridgeLinkSessions)
    .set({
      outcome: input.outcome,
      ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
      updatedAt: input.at,
    })
    .where(eq(bridgeLinkSessions.id, input.id))
    .returning(SESSION_PUBLIC_COLUMNS);
  return rows[0];
}
