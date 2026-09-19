/**
 * `history_offers`, `account_backups`, and the retention of the blobs they name.
 *
 * Routes never build SQL; they call these. Every function takes the handle
 * last, defaulting to the pool; the ones that change retention demand a
 * transaction, because a status change and the dating of its chunks must
 * commit together or a chunk is dated for an offer that is still pending.
 *
 * ## Chunk retention, the whole rule
 *
 * A blob named by a pending offer or by the backup carries `expires_at = null`
 * ({@link retainChunkBlobs}). When the thing naming it stops — the offer is
 * consumed, expires, is replaced, or the backup is replaced or deleted — the
 * blob is dated `now() + 1 day` ({@link releaseChunkBlobs}) UNLESS something
 * still names it: another pending offer, the backup, or a conversation event.
 * The day is the recipient's window to finish a download it started before it
 * called consume; after it, `db/expiry.ts` reaps the row.
 *
 * `sealed_key` and `key_check` are protected columns (`db/protectedColumns.ts`).
 * {@link HISTORY_OFFER_COLUMNS} and {@link ACCOUNT_BACKUP_COLUMNS} are the
 * explicit opt-ins: an offer is read with its sealed key because the recipient
 * is who reads it, and a backup with its key check because the account that
 * wrote it is who reads it. Neither table has a listing for anybody else.
 */

import { and, asc, eq, inArray, isNull, lt, lte, notExists, sql } from "drizzle-orm";
import { publicColumns } from "@oxy.so/db/assert";
import { uuidv7 } from "@oxy.so/db";
import { HISTORY_OFFER_TTL_MS, type ArchiveManifest } from "@allo/shared-types";
import { getDb, type AlloDatabase, type AlloDatabaseOrTransaction } from "../index";
import { requireTransaction } from "../moderation/transactionGuard";
import { PROTECTED_COLUMNS } from "../protectedColumns";
import { blobs } from "../schema/blobs";
import { namedByLiveStatus } from "./statusRepository";
import { conversationEvents } from "../schema/events";
import { accountBackups, historyOffers } from "../schema/history";

/** How long a released chunk lives after the last thing naming it let go. */
export const CHUNK_RELEASE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * How old an undated blob must be before the collector's orphan pass may
 * date it. Equal to the offer TTL on purpose: a chunk uploaded for an offer
 * that was never created is otherwise dated at upload and reaped by the
 * ordinary sweep; one that WAS retained and lost its offer row cannot be
 * younger than the offer that named it, which lived at most this long.
 */
export const ORPHAN_CHUNK_MIN_AGE_MS = HISTORY_OFFER_TTL_MS;

// --- history offers -------------------------------------------------------------

/** Every column but the sealed key: what a listing for anyone other than the recipient would read. */
export const HISTORY_OFFER_PUBLIC_COLUMNS = publicColumns(historyOffers, PROTECTED_COLUMNS);

/**
 * The recipient's read, and the donor's answer to its own `POST`: the offer
 * WITH `sealed_key`. This is the opt-in `protectedColumns.ts` asks for; it is
 * spelled out rather than `select()` so a reader of this file sees the
 * protected column being included on purpose.
 */
export const HISTORY_OFFER_COLUMNS = {
  ...HISTORY_OFFER_PUBLIC_COLUMNS,
  sealedKey: historyOffers.sealedKey,
};
export type HistoryOfferRow = {
  [K in keyof typeof HISTORY_OFFER_COLUMNS]: (typeof historyOffers.$inferSelect)[K];
};

export interface InsertHistoryOfferInput {
  accountId: string;
  donorInstanceId: string;
  recipientInstanceId: string;
  manifest: ArchiveManifest;
  sealedKey: string;
  manifestSignature: string;
  now: Date;
}

export async function insertHistoryOffer(
  input: InsertHistoryOfferInput,
  db: AlloDatabaseOrTransaction,
): Promise<HistoryOfferRow> {
  const tx = requireTransaction(db, "insertHistoryOffer");
  const [row] = await tx
    .insert(historyOffers)
    .values({
      id: uuidv7(),
      accountId: input.accountId,
      donorInstanceId: input.donorInstanceId,
      recipientInstanceId: input.recipientInstanceId,
      manifest: input.manifest,
      sealedKey: input.sealedKey,
      manifestSignature: input.manifestSignature,
      chunkBlobIds: [...input.manifest.chunkBlobIds],
      status: "pending",
      expiresAt: new Date(input.now.getTime() + HISTORY_OFFER_TTL_MS),
    })
    .returning(HISTORY_OFFER_COLUMNS);
  return row;
}

export async function findHistoryOfferById(
  id: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<HistoryOfferRow | null> {
  const [row] = await db.select(HISTORY_OFFER_COLUMNS).from(historyOffers).where(eq(historyOffers.id, id)).limit(1);
  return row ?? null;
}

/** The recipient's inbox, oldest first. Past-due rows are included: the service decides they are expired. */
export async function listPendingOffersForRecipient(
  recipientInstanceId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<HistoryOfferRow[]> {
  return db
    .select(HISTORY_OFFER_COLUMNS)
    .from(historyOffers)
    .where(and(eq(historyOffers.recipientInstanceId, recipientInstanceId), eq(historyOffers.status, "pending")))
    .orderBy(asc(historyOffers.createdAt), asc(historyOffers.id));
}

/**
 * `pending` → `expired` for every pending offer from `donorInstanceId` to
 * `recipientInstanceId`, and release their chunks. Returns the rows expired.
 * Called with the NEW offer already inserted, so a chunk both offers name
 * stays retained.
 */
export async function expireReplacedOffers(
  donorInstanceId: string,
  recipientInstanceId: string,
  exceptOfferId: string,
  db: AlloDatabaseOrTransaction,
): Promise<HistoryOfferRow[]> {
  const tx = requireTransaction(db, "expireReplacedOffers");
  const rows = await tx
    .update(historyOffers)
    .set({ status: "expired" })
    .where(
      and(
        eq(historyOffers.donorInstanceId, donorInstanceId),
        eq(historyOffers.recipientInstanceId, recipientInstanceId),
        eq(historyOffers.status, "pending"),
        sql`${historyOffers.id} <> ${exceptOfferId}`,
      ),
    )
    .returning(HISTORY_OFFER_COLUMNS);
  await releaseChunkBlobs(rows.flatMap((row) => row.chunkBlobIds), tx);
  return rows;
}

/**
 * `pending` → `expired` for every pending offer whose deadline has passed,
 * and release their chunks. `recipientInstanceId` narrows it to one inbox
 * (the read path); without it, it is the sweep's pre-pass over every row.
 * Returns how many were expired.
 */
export async function expireDueOffers(
  now: Date,
  recipientInstanceId: string | undefined,
  db: AlloDatabaseOrTransaction,
): Promise<number> {
  const tx = requireTransaction(db, "expireDueOffers");
  const rows = await tx
    .update(historyOffers)
    .set({ status: "expired" })
    .where(
      and(
        eq(historyOffers.status, "pending"),
        lte(historyOffers.expiresAt, now),
        recipientInstanceId === undefined ? undefined : eq(historyOffers.recipientInstanceId, recipientInstanceId),
      ),
    )
    .returning({ chunkBlobIds: historyOffers.chunkBlobIds });
  await releaseChunkBlobs(rows.flatMap((row) => row.chunkBlobIds), tx);
  return rows.length;
}

/**
 * `pending` → `consumed`, and release the chunks. Null when the row was not
 * pending any more (consumed already, or expired) so the caller can answer
 * with the conflict rather than a second success.
 */
export async function consumeHistoryOffer(
  id: string,
  now: Date,
  db: AlloDatabaseOrTransaction,
): Promise<HistoryOfferRow | null> {
  const tx = requireTransaction(db, "consumeHistoryOffer");
  const [row] = await tx
    .update(historyOffers)
    .set({ status: "consumed", consumedAt: now })
    .where(and(eq(historyOffers.id, id), eq(historyOffers.status, "pending")))
    .returning(HISTORY_OFFER_COLUMNS);
  if (!row) return null;
  await releaseChunkBlobs(row.chunkBlobIds, tx);
  return row;
}

// --- account backups ------------------------------------------------------------

export const ACCOUNT_BACKUP_PUBLIC_COLUMNS = publicColumns(accountBackups, PROTECTED_COLUMNS);

/** The owner's read: the backup WITH `key_check`. The opt-in, spelled out as above. */
export const ACCOUNT_BACKUP_COLUMNS = {
  ...ACCOUNT_BACKUP_PUBLIC_COLUMNS,
  keyCheck: accountBackups.keyCheck,
};
export type AccountBackupRow = {
  [K in keyof typeof ACCOUNT_BACKUP_COLUMNS]: (typeof accountBackups.$inferSelect)[K];
};

export async function findBackupByAccount(
  accountId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<AccountBackupRow | null> {
  const [row] = await db
    .select(ACCOUNT_BACKUP_COLUMNS)
    .from(accountBackups)
    .where(eq(accountBackups.accountId, accountId))
    .limit(1);
  return row ?? null;
}

export interface PutBackupInput {
  accountId: string;
  instanceId: string;
  manifest: ArchiveManifest;
  keyCheck: string;
  manifestSignature: string;
  now: Date;
}

/**
 * Insert or replace the account's backup, retain the new chunks and release
 * the previous backup's chunks that the new one does not name. One statement
 * for the row (`ON CONFLICT (account_id)`) so two instances writing at once
 * cannot both insert; the loser's chunks are released by the winner's next
 * write or by the orphan pass.
 */
export async function putBackup(input: PutBackupInput, db: AlloDatabaseOrTransaction): Promise<AccountBackupRow> {
  const tx = requireTransaction(db, "putBackup");
  const previous = await tx
    .select({ chunkBlobIds: accountBackups.chunkBlobIds })
    .from(accountBackups)
    .where(eq(accountBackups.accountId, input.accountId))
    .for("update");
  const chunkBlobIds = [...input.manifest.chunkBlobIds];
  const values = {
    instanceId: input.instanceId,
    manifest: input.manifest,
    keyCheck: input.keyCheck,
    manifestSignature: input.manifestSignature,
    chunkBlobIds,
    updatedAt: input.now,
  };
  const [row] = await tx
    .insert(accountBackups)
    .values({ accountId: input.accountId, ...values })
    .onConflictDoUpdate({ target: accountBackups.accountId, set: values })
    .returning(ACCOUNT_BACKUP_COLUMNS);
  await retainChunkBlobs(chunkBlobIds, tx);
  const dropped = (previous[0]?.chunkBlobIds ?? []).filter((id) => !chunkBlobIds.includes(id));
  await releaseChunkBlobs(dropped, tx);
  return row;
}

/** Delete the account's backup and release its chunks. Null when there was none. */
export async function deleteBackup(accountId: string, db: AlloDatabaseOrTransaction): Promise<AccountBackupRow | null> {
  const tx = requireTransaction(db, "deleteBackup");
  const [row] = await tx.delete(accountBackups).where(eq(accountBackups.accountId, accountId)).returning(ACCOUNT_BACKUP_COLUMNS);
  if (!row) return null;
  await releaseChunkBlobs(row.chunkBlobIds, tx);
  return row;
}

// --- chunk blobs ----------------------------------------------------------------

export interface ChunkBlobOwner {
  id: string;
  uploaderAccountId: string;
}

/** The blobs among `ids` that exist, with who uploaded them. The service checks the count and the owner. */
export async function findChunkBlobOwners(
  ids: readonly string[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<ChunkBlobOwner[]> {
  if (ids.length === 0) return [];
  return db.select({ id: blobs.id, uploaderAccountId: blobs.uploaderAccountId }).from(blobs).where(inArray(blobs.id, [...ids]));
}

/** An offer or the backup names these blobs: undated until released. */
export async function retainChunkBlobs(ids: readonly string[], db: AlloDatabaseOrTransaction): Promise<void> {
  const tx = requireTransaction(db, "retainChunkBlobs");
  if (ids.length === 0) return;
  await tx.update(blobs).set({ expiresAt: null }).where(inArray(blobs.id, [...ids]));
}

/** `NOT EXISTS (pending offer naming the blob)`, correlated on the outer `blobs` row. */
export const namedByPendingOffer = (db: AlloDatabaseOrTransaction) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(historyOffers)
      .where(and(eq(historyOffers.status, "pending"), sql`${blobs.id} = any(${historyOffers.chunkBlobIds})`)),
  );

/** `NOT EXISTS (backup naming the blob)`. */
export const namedByBackup = (db: AlloDatabaseOrTransaction) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(accountBackups)
      .where(sql`${blobs.id} = any(${accountBackups.chunkBlobIds})`),
  );

/** `NOT EXISTS (event naming the blob)` — the GIN index on `blob_ids` answers it. */
export const namedByEvent = (db: AlloDatabaseOrTransaction) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(conversationEvents)
      .where(sql`${conversationEvents.blobIds} @> array[${blobs.id}]::text[]`),
  );

/**
 * Nothing that was naming these blobs names them any more: date each
 * `now() + 1 day` — unless a pending offer, the backup or an event still
 * does, in which case it stays as it is. Unknown ids are ignored.
 *
 * The three `NOT EXISTS` are evaluated by the database against the state at
 * the statement, which is why the caller inserts or marks first and releases
 * last: what is still live is whatever is live THEN.
 */
export async function releaseChunkBlobs(ids: readonly string[], db: AlloDatabaseOrTransaction): Promise<void> {
  const tx = requireTransaction(db, "releaseChunkBlobs");
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  await tx
    .update(blobs)
    .set({ expiresAt: sql`now() + make_interval(secs => ${CHUNK_RELEASE_TTL_MS / 1_000})` })
    .where(and(inArray(blobs.id, unique), namedByPendingOffer(tx), namedByBackup(tx), namedByEvent(tx), namedByLiveStatus(tx)));
}

/**
 * The collector's orphan pass: an undated blob at least {@link ORPHAN_CHUNK_MIN_AGE_MS}
 * old that no pending offer, no backup and no event names is a chunk whose
 * offer row went without releasing it (or a chunk retained for a backup row
 * that a concurrent write replaced). Date it `now() + 1 day`. Returns the ids.
 *
 * Only `retainBlobs` (an event) and `retainChunkBlobs` (an offer or the
 * backup) ever clear `expires_at`, so an undated blob none of the three names
 * is by construction one of those two with its reference gone. This visits
 * every undated blob older than the threshold on each pass, hourly; the event
 * probe is a GIN lookup per row. Acceptable at this platform's size, and the
 * pass exists as a backstop — `runExpirySweep` releases due offers before it
 * deletes them, so in the ordinary course this finds nothing.
 */
export async function dateOrphanedChunkBlobs(now: Date, db: AlloDatabase = getDb()): Promise<string[]> {
  const threshold = new Date(now.getTime() - ORPHAN_CHUNK_MIN_AGE_MS);
  const rows = await db
    .update(blobs)
    .set({ expiresAt: new Date(now.getTime() + CHUNK_RELEASE_TTL_MS) })
    .where(
      and(
        isNull(blobs.expiresAt),
        lt(blobs.createdAt, threshold),
        namedByPendingOffer(db),
        namedByBackup(db),
        namedByLiveStatus(db),
        namedByEvent(db),
      ),
    )
    .returning({ id: blobs.id });
  return rows.map((row) => row.id);
}
