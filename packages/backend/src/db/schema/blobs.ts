/**
 * Encrypted blobs: media bytes a client encrypted with a key that travels
 * only inside a `media` app message. The server checks size and digest and
 * nothing else.
 *
 * `blobs` is the metadata; `blob_bytes` is the Postgres `BlobStore`
 * implementation (`db/platform/blobRepository.ts`), a separate table so the
 * metadata row can be listed and collected without dragging megabytes through
 * the page cache, and so an S3 store can replace it later without touching
 * `blobs` at all.
 *
 * `expires_at` is set to seven days at upload and cleared to NULL the moment an
 * event names the blob in its `blobIds`; `db/expiry.ts` sweeps what is still
 * dated. `blob_bytes.data` is registered in `protectedColumns.ts`: the one
 * reader that returns it is `GET /v1/blobs/:id`.
 */

import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text } from "drizzle-orm/pg-core";
import { bytea, createdAt, timestamptz } from "@oxy.so/db";

export const blobs = pgTable(
  "blobs",
  {
    /** 32 random bytes, hex: unguessable, which is what makes an authenticated read by id safe. */
    id: text().primaryKey(),
    uploaderInstanceId: text().notNull(),
    uploaderAccountId: text().notNull(),
    size: bigint({ mode: "number" }).notNull(),
    sha256: text().notNull(),
    /** Which store holds the bytes; `postgres` names `blob_bytes`. */
    storageKey: text().notNull(),
    createdAt: createdAt(),
    expiresAt: timestamptz(),
  },
  (t) => [
    index("blobs_expires_at_idx").on(t.expiresAt),
    index("blobs_uploader_instance_id_idx").on(t.uploaderInstanceId),
    check("blobs_size_check", sql`${t.size} >= 0`),
  ],
);

export const blobBytes = pgTable("blob_bytes", {
  blobId: text()
    .primaryKey()
    .references(() => blobs.id, { onDelete: "cascade" }),
  data: bytea().notNull(),
});
