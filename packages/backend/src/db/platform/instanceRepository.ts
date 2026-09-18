/**
 * `client_instances` — every query that touches an installation's row.
 *
 * Routes never build SQL; they call these. Every function takes the handle
 * last, defaulting to the pool, so a caller inside a transaction passes its
 * own and one outside it passes nothing.
 *
 * `pushToken` is a protected column (`db/protectedColumns.ts`): the only
 * reader that returns it is {@link findPushTarget}, for the delivery worker.
 */

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { publicColumns } from "@oxy.so/db/assert";
import { uuidv7 } from "@oxy.so/db";
import { getDb, type AlloDatabaseOrTransaction } from "../index";
import { PROTECTED_COLUMNS } from "../protectedColumns";
import { clientInstances, type InstancePlatform, type InstancePushProvider, type InstanceStatus } from "../schema/instances";

/** Every column but the push token. What a route may read. */
export const INSTANCE_COLUMNS = publicColumns(clientInstances, PROTECTED_COLUMNS);
export type InstanceRow = {
  [K in keyof typeof INSTANCE_COLUMNS]: (typeof clientInstances.$inferSelect)[K];
};

export interface InsertInstanceInput {
  accountId: string;
  appId: string;
  platform: InstancePlatform;
  displayName: string;
  signingPublicKey: string;
  /** Raw 32-byte X25519 public key, base64. Required at registration since Phase 3. */
  transferPublicKey: string;
  status: InstanceStatus;
  enrollmentChallenge: string | null;
}

export async function insertInstance(
  input: InsertInstanceInput,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<InstanceRow> {
  const now = new Date();
  const [row] = await db
    .insert(clientInstances)
    .values({
      id: uuidv7(),
      accountId: input.accountId,
      appId: input.appId,
      platform: input.platform,
      displayName: input.displayName,
      signingPublicKey: input.signingPublicKey,
      transferPublicKey: input.transferPublicKey,
      status: input.status,
      enrollmentChallenge: input.enrollmentChallenge,
      enrolledAt: input.status === "active" ? now : null,
      lastSeenAt: now,
    })
    .returning(INSTANCE_COLUMNS);
  return row;
}

export async function findInstanceById(
  id: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<InstanceRow | null> {
  const [row] = await db.select(INSTANCE_COLUMNS).from(clientInstances).where(eq(clientInstances.id, id)).limit(1);
  return row ?? null;
}

export async function findInstancesByIds(
  ids: readonly string[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<InstanceRow[]> {
  if (ids.length === 0) return [];
  return db.select(INSTANCE_COLUMNS).from(clientInstances).where(inArray(clientInstances.id, [...ids]));
}

export async function listInstancesByAccount(
  accountId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<InstanceRow[]> {
  return db
    .select(INSTANCE_COLUMNS)
    .from(clientInstances)
    .where(eq(clientInstances.accountId, accountId))
    .orderBy(asc(clientInstances.createdAt), asc(clientInstances.id));
}

export async function listInstancesByAccountAndStatus(
  accountId: string,
  status: InstanceStatus,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<InstanceRow[]> {
  return db
    .select(INSTANCE_COLUMNS)
    .from(clientInstances)
    .where(and(eq(clientInstances.accountId, accountId), eq(clientInstances.status, status)))
    .orderBy(asc(clientInstances.createdAt), asc(clientInstances.id));
}

/**
 * How many active instances an account has, read under `FOR UPDATE` on the
 * matching rows when called inside a transaction, so two simultaneous first
 * registrations cannot both see zero and both become active. The lock is on
 * the existing rows; when there are none there is nothing to lock, and two
 * concurrent bootstraps on a brand-new account both succeed — accepted, and
 * stated here rather than hidden: it takes two installations racing to the
 * same never-seen account within one round trip, and the outcome is two
 * active instances, which the owner can revoke.
 */
export async function countActiveInstances(
  accountId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<number> {
  const rows = await db
    .select({ id: clientInstances.id })
    .from(clientInstances)
    .where(and(eq(clientInstances.accountId, accountId), eq(clientInstances.status, "active")))
    .for("update");
  return rows.length;
}

export interface ActivateInstanceInput {
  approvedByInstanceId: string;
  approvalSignature: string;
}

/**
 * `pending` → `active`. Returns null when the row was not pending (already
 * resolved). The challenge is KEPT: it is what the approval signature was made
 * over, and once signed it is published so any client can verify the chain
 * (`publishedChallenge` in `services/platform/wire.ts`).
 */
export async function activateInstance(
  id: string,
  input: ActivateInstanceInput,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<InstanceRow | null> {
  const now = new Date();
  const [row] = await db
    .update(clientInstances)
    .set({
      status: "active",
      approvedByInstanceId: input.approvedByInstanceId,
      approvalSignature: input.approvalSignature,
      enrolledAt: now,
      updatedAt: now,
    })
    .where(and(eq(clientInstances.id, id), eq(clientInstances.status, "pending")))
    .returning(INSTANCE_COLUMNS);
  return row ?? null;
}

/** Any status → `revoked`. Idempotent: returns the row either way, null when it does not exist. */
export async function revokeInstance(
  id: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<InstanceRow | null> {
  const now = new Date();
  const [row] = await db
    .update(clientInstances)
    .set({
      status: "revoked",
      enrollmentChallenge: null,
      revokedAt: sql`coalesce(${clientInstances.revokedAt}, ${now.toISOString()}::timestamptz)`,
      pushProvider: null,
      pushToken: null,
      updatedAt: now,
    })
    .where(eq(clientInstances.id, id))
    .returning(INSTANCE_COLUMNS);
  return row ?? null;
}

/**
 * Set the transfer key of an instance registered before the column existed
 * (or rotate it). Returns the row after, null when the instance does not exist.
 */
export async function setTransferPublicKey(
  id: string,
  transferPublicKey: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<InstanceRow | null> {
  const [row] = await db
    .update(clientInstances)
    .set({ transferPublicKey, updatedAt: new Date() })
    .where(eq(clientInstances.id, id))
    .returning(INSTANCE_COLUMNS);
  return row ?? null;
}

export async function setPushToken(
  id: string,
  provider: InstancePushProvider,
  token: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(clientInstances)
    .set({ pushProvider: provider, pushToken: token, updatedAt: new Date() })
    .where(eq(clientInstances.id, id));
}

export async function clearPushToken(id: string, db: AlloDatabaseOrTransaction = getDb()): Promise<void> {
  await db
    .update(clientInstances)
    .set({ pushProvider: null, pushToken: null, updatedAt: new Date() })
    .where(eq(clientInstances.id, id));
}

/** Clear a token the provider rejected — but only if it is still the one that was rejected. */
export async function clearRejectedPushToken(
  id: string,
  token: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<void> {
  await db
    .update(clientInstances)
    .set({ pushProvider: null, pushToken: null, updatedAt: new Date() })
    .where(and(eq(clientInstances.id, id), eq(clientInstances.pushToken, token)));
}

export interface PushTarget {
  instanceId: string;
  status: InstanceStatus;
  platform: InstancePlatform;
  pushProvider: InstancePushProvider | null;
  /** The protected column, read on purpose: this is the worker's opt-in. */
  pushToken: string | null;
}

/** The delivery worker's read. The ONE place `push_token` leaves the table. */
export async function findPushTargets(
  ids: readonly string[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<PushTarget[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      instanceId: clientInstances.id,
      status: clientInstances.status,
      platform: clientInstances.platform,
      pushProvider: clientInstances.pushProvider,
      pushToken: clientInstances.pushToken,
    })
    .from(clientInstances)
    .where(inArray(clientInstances.id, [...ids]));
  return rows;
}

export async function touchLastSeen(id: string, db: AlloDatabaseOrTransaction = getDb()): Promise<void> {
  await db.update(clientInstances).set({ lastSeenAt: new Date() }).where(eq(clientInstances.id, id));
}
