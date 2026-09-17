/**
 * Blobs (`docs/platform/api-v1.md`, Blobs).
 */

import { randomBytes } from "node:crypto";
import { DEFAULT_MAX_BLOB_BYTES, type UploadBlobResponse } from "@allo/shared-types";
import { getDb, type AlloDatabase } from "../../db";
import {
  BLOB_UNREFERENCED_TTL_MS,
  findBlobById,
  insertBlob,
  postgresBlobStore,
  type BlobStore,
} from "../../db/platform/blobRepository";
import { sha256Hex } from "../../middleware/instanceAuth";
import { AlloHttpError, notFound, validationFailed } from "../../utils/httpErrors";

export interface BlobServiceDeps {
  db?: AlloDatabase;
  store?: BlobStore;
  maxBytes?: number;
}

/** `ALLO_BLOB_MAX_BYTES`, or the contract's default. Refuses nonsense loudly. */
export function blobMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALLO_BLOB_MAX_BYTES?.trim();
  if (!raw) return DEFAULT_MAX_BLOB_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("ALLO_BLOB_MAX_BYTES must be a positive integer number of bytes");
  }
  return parsed;
}

export async function uploadBlob(
  uploader: { instanceId: string; accountId: string },
  input: { bytes: Buffer; declaredSha256: string | undefined },
  deps: BlobServiceDeps = {},
): Promise<UploadBlobResponse> {
  const db = deps.db ?? getDb();
  const store = deps.store ?? postgresBlobStore();
  const max = deps.maxBytes ?? blobMaxBytes();
  if (input.bytes.length > max) throw new AlloHttpError("payload_too_large", `A blob is at most ${max} bytes`);
  if (input.bytes.length === 0) throw validationFailed("an empty blob is not a blob");
  if (input.declaredSha256 === undefined) throw validationFailed("X-Allo-Blob-Sha256 is required");
  const actual = sha256Hex(input.bytes);
  if (actual !== input.declaredSha256.toLowerCase()) {
    throw validationFailed("X-Allo-Blob-Sha256 does not match the body");
  }
  const id = randomBytes(32).toString("hex");
  await db.transaction(async (tx) => {
    await insertBlob(
      {
        id,
        uploaderInstanceId: uploader.instanceId,
        uploaderAccountId: uploader.accountId,
        size: input.bytes.length,
        sha256: actual,
        storageKey: store.storageKey,
        expiresAt: new Date(Date.now() + BLOB_UNREFERENCED_TTL_MS),
      },
      tx,
    );
    await store.put(id, input.bytes, tx);
  });
  return { blobId: id, size: input.bytes.length };
}

export async function downloadBlob(id: string, deps: BlobServiceDeps = {}): Promise<Buffer> {
  const db = deps.db ?? getDb();
  const store = deps.store ?? postgresBlobStore();
  const row = await findBlobById(id, db);
  if (!row) throw notFound("Blob not found");
  const bytes = await store.get(id, db);
  if (!bytes) throw notFound("Blob not found");
  return bytes;
}
