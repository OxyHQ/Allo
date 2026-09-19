/**
 * `statuses`, `status_keys`, `status_views` — SQL only.
 *
 * The protected columns (`payload`, `nonce`, `sealedKey`) are opted into by
 * name here, once, and the opt-in reads differently from an ordinary select on
 * purpose: these are the two routes that hand a device the ciphertext and the
 * key that belong to it, and there is no third.
 *
 * An inbox read is one index probe on `status_keys(instance_id, expires_at)`
 * joined to its status, not a scan of everything live: an account that follows
 * nobody should pay nothing for a feature it does not use.
 */

import { and, desc, eq, gt, inArray, notExists, sql } from "drizzle-orm";
import { uuidv7 } from "@oxy.so/db";
import { requireTransaction } from "../moderation/transactionGuard";
import type { AlloDatabase, AlloDatabaseOrTransaction } from "../index";
import { blobs } from "../schema/blobs";
import { namedByBackup, namedByEvent, namedByPendingOffer } from "./historyRepository";
import { statuses, statusKeys, statusViews } from "../schema/statuses";

/** The whole row, ciphertext included. Named so the reader sees the opt-in. */
const STATUS_WITH_CIPHERTEXT = {
  id: statuses.id,
  authorAccountId: statuses.authorAccountId,
  authorInstanceId: statuses.authorInstanceId,
  payload: statuses.payload,
  nonce: statuses.nonce,
  sha256: statuses.sha256,
  blobIds: statuses.blobIds,
  signature: statuses.signature,
  state: statuses.state,
  createdAt: statuses.createdAt,
  expiresAt: statuses.expiresAt,
} as const;

export type StatusRow = {
  [K in keyof typeof STATUS_WITH_CIPHERTEXT]: (typeof statuses.$inferSelect)[K];
};

export interface InsertStatusInput {
  /** The author's own id for it, which its signature covers. */
  id: string;
  authorAccountId: string;
  authorInstanceId: string;
  payload: Buffer;
  nonce: Buffer;
  sha256: string;
  blobIds: string[];
  signature: string;
  idempotencyKey: string;
  expiresAt: Date;
}

export async function insertStatus(input: InsertStatusInput, db: AlloDatabaseOrTransaction): Promise<StatusRow> {
  requireTransaction(db, "insertStatus");
  const [row] = await db
    .insert(statuses)
    .values(input)
    .returning(STATUS_WITH_CIPHERTEXT);
  return row;
}

/** The status this instance already posted under this key, if it did. */
export async function findStatusByIdempotencyKey(
  authorInstanceId: string,
  idempotencyKey: string,
  db: AlloDatabaseOrTransaction,
): Promise<StatusRow | null> {
  const [row] = await db
    .select(STATUS_WITH_CIPHERTEXT)
    .from(statuses)
    .where(and(eq(statuses.authorInstanceId, authorInstanceId), eq(statuses.idempotencyKey, idempotencyKey)))
    .limit(1);
  return row ?? null;
}

export async function findStatusById(id: string, db: AlloDatabaseOrTransaction): Promise<StatusRow | null> {
  const [row] = await db.select(STATUS_WITH_CIPHERTEXT).from(statuses).where(eq(statuses.id, id)).limit(1);
  return row ?? null;
}

export interface InsertStatusKeyInput {
  statusId: string;
  instanceId: string;
  accountId: string;
  sealedKey: string;
  expiresAt: Date;
}

export async function insertStatusKeys(rows: readonly InsertStatusKeyInput[], db: AlloDatabaseOrTransaction): Promise<void> {
  requireTransaction(db, "insertStatusKeys");
  if (rows.length === 0) return;
  await db
    .insert(statusKeys)
    .values(rows.map((row) => ({ id: uuidv7(), ...row })))
    .onConflictDoNothing({ target: [statusKeys.statusId, statusKeys.instanceId] });
}

export interface InboxRow {
  status: StatusRow;
  sealedKey: string;
}

/** Everything live that is sealed to THIS instance, newest first. */
export async function listInbox(instanceId: string, limit: number, db: AlloDatabaseOrTransaction): Promise<InboxRow[]> {
  const rows = await db
    .select({ ...STATUS_WITH_CIPHERTEXT, sealedKey: statusKeys.sealedKey })
    .from(statusKeys)
    .innerJoin(statuses, eq(statuses.id, statusKeys.statusId))
    // BOTH deadlines: the key's, which is what the index answers on, and the
    // status's own, so a status taken down between the two writes cannot be
    // listed by a key that has not caught up yet.
    .where(
      and(
        eq(statusKeys.instanceId, instanceId),
        gt(statusKeys.expiresAt, sql`now()`),
        gt(statuses.expiresAt, sql`now()`),
        eq(statuses.state, "live"),
      ),
    )
    .orderBy(desc(statuses.createdAt))
    .limit(limit);
  return rows.map(({ sealedKey, ...status }) => ({ status, sealedKey }));
}

/** What this account has posted and not yet lost, newest first. The author holds the key already. */
export async function listOwn(accountId: string, limit: number, db: AlloDatabaseOrTransaction): Promise<StatusRow[]> {
  return db
    .select(STATUS_WITH_CIPHERTEXT)
    .from(statuses)
    .where(and(eq(statuses.authorAccountId, accountId), gt(statuses.expiresAt, sql`now()`), eq(statuses.state, "live")))
    .orderBy(desc(statuses.createdAt))
    .limit(limit);
}

/** Whether this instance holds a key for this status — i.e. whether it may read or view it. */
export async function holdsKey(statusId: string, instanceId: string, db: AlloDatabaseOrTransaction): Promise<boolean> {
  const [row] = await db
    .select({ id: statusKeys.id })
    .from(statusKeys)
    .where(and(eq(statusKeys.statusId, statusId), eq(statusKeys.instanceId, instanceId)))
    .limit(1);
  return Boolean(row);
}

/**
 * The author took it down. The row stays until its deadline so a device that
 * already has it can be told it is gone, and the blobs are released with it.
 */
export async function markStatusDeleted(id: string, at: Date, db: AlloDatabaseOrTransaction): Promise<void> {
  await db.update(statuses).set({ state: "deleted", expiresAt: at }).where(eq(statuses.id, id));
  await db.update(statusKeys).set({ expiresAt: at }).where(eq(statusKeys.statusId, id));
}

export interface RecordViewInput {
  statusId: string;
  accountId: string;
  published: boolean;
  viewedAt: Date;
  expiresAt: Date;
}

/** One row per viewing ACCOUNT. Seeing it twice is not seeing it twice. */
export async function recordView(input: RecordViewInput, db: AlloDatabaseOrTransaction): Promise<void> {
  await db
    .insert(statusViews)
    .values({
      id: uuidv7(),
      statusId: input.statusId,
      accountId: input.accountId,
      published: input.published ? "yes" : "no",
      viewedAt: input.viewedAt,
      expiresAt: input.expiresAt,
    })
    .onConflictDoNothing({ target: [statusViews.statusId, statusViews.accountId] });
}

export interface ViewsSummary {
  views: { accountId: string; viewedAt: Date }[];
  total: number;
}

/** Who viewed, as the author may see it: the names that publish, and the count of everybody. */
export async function listViews(statusId: string, db: AlloDatabaseOrTransaction): Promise<ViewsSummary> {
  const rows = await db
    .select({ accountId: statusViews.accountId, viewedAt: statusViews.viewedAt, published: statusViews.published })
    .from(statusViews)
    .where(eq(statusViews.statusId, statusId))
    .orderBy(desc(statusViews.viewedAt));
  return {
    views: rows.filter((row) => row.published === "yes").map(({ accountId, viewedAt }) => ({ accountId, viewedAt })),
    total: rows.length,
  };
}

/**
 * `NOT EXISTS (a live status naming the blob)`.
 *
 * The blob collector consults this the way it consults pending offers, the
 * backup and events: a picture attached to a status that is still live must
 * not be reaped out from under it, whatever else stopped naming it.
 */
export const namedByLiveStatus = (db: AlloDatabaseOrTransaction) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(statuses)
      .where(and(sql`${statuses.expiresAt} > now()`, eq(statuses.state, "live"), sql`${statuses.blobIds} @> array[${blobs.id}]::text[]`)),
  );

/**
 * Date the blobs of every status past its deadline, so the collector reaps
 * them on its own schedule — unless something else still names them.
 *
 * The same shape as `releaseDueHistoryOffers`, and for the same reason: the
 * server cannot read the envelope that names a blob, so the deadline of the
 * thing that named it is all it has to go on. Returns how many blobs were
 * dated, which is what the sweep logs.
 */
export async function releaseDueStatusBlobs(db: AlloDatabase): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ blobIds: statuses.blobIds })
      .from(statuses)
      .where(sql`${statuses.expiresAt} <= now()`);
    const ids = [...new Set(rows.flatMap((row) => row.blobIds))];
    if (ids.length === 0) return 0;
    const dated = await tx
      .update(blobs)
      .set({ expiresAt: sql`now() + make_interval(secs => ${STATUS_BLOB_RELEASE_TTL_MS / 1_000})` })
      .where(and(inArray(blobs.id, ids), namedByPendingOffer(tx), namedByBackup(tx), namedByEvent(tx), namedByLiveStatus(tx)))
      .returning({ id: blobs.id });
    return dated.length;
  });
}

/**
 * How long a released status blob survives.
 *
 * A day, like a history chunk's: a device that started fetching a picture just
 * as the status expired finishes, rather than failing halfway through on a
 * body that vanished.
 */
export const STATUS_BLOB_RELEASE_TTL_MS = 24 * 60 * 60 * 1000;

/** Statuses of these ids that are still live. Used to keep a listing honest about what it hands back. */
export async function liveStatusIds(ids: readonly string[], db: AlloDatabaseOrTransaction): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(inArray(statuses.id, [...ids]), gt(statuses.expiresAt, sql`now()`), eq(statuses.state, "live")));
  return new Set(rows.map((row) => row.id));
}
