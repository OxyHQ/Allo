/**
 * `blobs` metadata, and the `BlobStore` that holds the bytes.
 *
 * The store is an interface so the bytes can move to S3 without the metadata
 * or the routes changing. The Postgres implementation is `blob_bytes`, and
 * `data` there is a protected column: {@link postgresBlobStore}'s `get` is the
 * one reader.
 */

import { and, eq, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { getDb, type AlloDatabase, type AlloDatabaseOrTransaction } from "../index";
import { requireTransaction } from "../moderation/transactionGuard";
import { blobBytes, blobs } from "../schema/blobs";
import { clientInstances } from "../schema/instances";

export type BlobRow = typeof blobs.$inferSelect;

/** How long an unreferenced upload lives. */
export const BLOB_UNREFERENCED_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export const POSTGRES_STORAGE_KEY = "postgres";

export interface BlobStore {
  readonly storageKey: string;
  put(blobId: string, data: Buffer, db?: AlloDatabaseOrTransaction): Promise<void>;
  get(blobId: string, db?: AlloDatabaseOrTransaction): Promise<Buffer | null>;
}

export function postgresBlobStore(): BlobStore {
  return {
    storageKey: POSTGRES_STORAGE_KEY,
    async put(blobId, data, db = getDb()) {
      await db.insert(blobBytes).values({ blobId, data });
    },
    async get(blobId, db = getDb()) {
      const [row] = await db.select({ data: blobBytes.data }).from(blobBytes).where(eq(blobBytes.blobId, blobId)).limit(1);
      return row ? Buffer.from(row.data) : null;
    },
  };
}

export interface InsertBlobInput {
  id: string;
  uploaderInstanceId: string;
  uploaderAccountId: string;
  size: number;
  sha256: string;
  storageKey: string;
  expiresAt: Date;
}

export async function insertBlob(input: InsertBlobInput, db: AlloDatabaseOrTransaction = getDb()): Promise<BlobRow> {
  const [row] = await db.insert(blobs).values(input).returning();
  return row;
}

export async function findBlobById(id: string, db: AlloDatabaseOrTransaction = getDb()): Promise<BlobRow | null> {
  const [row] = await db.select().from(blobs).where(eq(blobs.id, id)).limit(1);
  return row ?? null;
}

/** An event named these blobs: they are kept for good. Unknown ids are ignored — the sender's declaration is never interpreted. */
export async function retainBlobs(ids: readonly string[], db: AlloDatabaseOrTransaction): Promise<void> {
  const tx = requireTransaction(db, "retainBlobs");
  if (ids.length === 0) return;
  await tx.update(blobs).set({ expiresAt: null }).where(inArray(blobs.id, [...ids]));
}

/**
 * The blob collector's delete: dated rows past their deadline, plus dated rows
 * whose uploader was revoked (an instance that will never send the message the
 * upload was for). `blob_bytes` goes by cascade. Returns the ids removed.
 */
export async function deleteCollectableBlobs(now: Date, db: AlloDatabase = getDb()): Promise<string[]> {
  const revokedUploaders = db
    .select({ id: clientInstances.id })
    .from(clientInstances)
    .where(eq(clientInstances.status, "revoked"));
  const rows = await db
    .delete(blobs)
    .where(
      or(
        lt(blobs.expiresAt, now),
        and(isNotNull(blobs.expiresAt), inArray(blobs.uploaderInstanceId, revokedUploaders)),
      ),
    )
    .returning({ id: blobs.id });
  return rows.map((row) => row.id);
}

export async function countBlobs(db: AlloDatabaseOrTransaction = getDb()): Promise<number> {
  const [row] = await db.select({ total: sql<number>`count(*)::int` }).from(blobs);
  return row?.total ?? 0;
}
