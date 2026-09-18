/**
 * History transfer and backup: how a new instance gets a timeline.
 *
 * A new instance is a new MLS leaf and live group state is never copied, so
 * history reaches it one of two ways, both E2EE and both described by a signed
 * `ArchiveManifest` (`@allo/shared-types`, `archive.ts`) whose chunks are
 * ordinary `blobs` rows:
 *
 * - `history_offers`: a donor instance offers another instance of the SAME
 *   account its archive, with the archive key sealed (HPKE) to the recipient's
 *   `client_instances.transfer_public_key`. One pending offer per (donor,
 *   recipient); a newer one marks the older `expired`.
 * - `account_backups`: one archive per account, whose key is derived from a
 *   recovery phrase the server never sees. `key_check` lets a client refuse a
 *   mistyped phrase before it downloads a chunk.
 *
 * The server stores and relays; it can open none of it.
 *
 * ## Chunk retention
 *
 * `chunk_blob_ids` duplicates `manifest.chunkBlobIds` as a `text[]` so the
 * retention queries can say `blobs.id = any(chunk_blob_ids)` without opening
 * the jsonb. A blob named by a live offer or the backup has `expires_at = null`;
 * on consume, expiry, replacement or deletion it is dated `now() + 1 day`
 * unless something else still names it (`historyRepository.ts`).
 *
 * `expires_at` on an offer is BOTH its logical deadline (`listPending` marks a
 * past-due offer `expired` and releases its chunks) and the row's sweep
 * deadline (`db/expiry.ts` deletes it). `runExpirySweep` releases due offers
 * before it deletes anything, so the row never goes without its chunks being
 * dated; the collector's orphan pass is the backstop should one ever do.
 *
 * Every CHECK is over column references only — nothing renders as `$1`.
 */

import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, updatedAt } from "@oxy.so/db";
import { HISTORY_OFFER_STATUSES, type ArchiveManifest } from "@allo/shared-types";
import { checkNonEmptyArray, checkOneOf } from "./columns";
import { clientInstances } from "./instances";

export type HistoryOfferStatus = (typeof HISTORY_OFFER_STATUSES)[number];

/**
 * `manifest` is `jsonb` because the format belongs to the clients (it is
 * versioned by them and signed by the donor); the server validates it on WRITE
 * with the contract schema and never queries inside it. `sealed_key` is a
 * protected column (`protectedColumns.ts`): the recipient is its one reader.
 */
export const historyOffers = pgTable(
  "history_offers",
  {
    id: text().primaryKey(),
    /** The account both instances belong to. An Oxy id: no FK (CONVENTIONS.md). */
    accountId: text().notNull(),
    donorInstanceId: text()
      .notNull()
      .references(() => clientInstances.id, { onDelete: "cascade" }),
    recipientInstanceId: text()
      .notNull()
      .references(() => clientInstances.id, { onDelete: "cascade" }),
    manifest: jsonb().$type<ArchiveManifest>().notNull(),
    /** HPKE `enc || ct` of the 32-byte archive key, base64, sealed to the recipient's transfer key. */
    sealedKey: text().notNull(),
    /** Ed25519 by the donor over `archiveManifestMessage(manifest)`, base64. */
    manifestSignature: text().notNull(),
    /** `manifest.chunkBlobIds`, in order, for the retention queries. */
    chunkBlobIds: text().array().notNull(),
    status: text({ enum: HISTORY_OFFER_STATUSES }).notNull().default("pending"),
    createdAt: createdAt(),
    consumedAt: timestamptz(),
    /** Set at insert to `created_at + 7 days` (`HISTORY_OFFER_TTL_MS`). */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    /** The recipient's inbox: `where recipient_instance_id = ? and status = 'pending'`. */
    index("history_offers_recipient_instance_id_status_idx").on(t.recipientInstanceId, t.status),
    /** The replacement lookup: the pending offer from this donor to this recipient. */
    index("history_offers_donor_recipient_status_idx").on(
      t.donorInstanceId,
      t.recipientInstanceId,
      t.status,
    ),
    /** The expiry sweep's leading btree. */
    index("history_offers_expires_at_idx").on(t.expiresAt),
    checkOneOf("history_offers_status_check", t.status, HISTORY_OFFER_STATUSES),
    checkNonEmptyArray("history_offers_chunk_blob_ids_check", t.chunkBlobIds),
  ],
);

/**
 * One row per account, replaced whole by every `PUT /v1/accounts/me/backup`.
 * `key_check` is a protected column: `GET /v1/accounts/me/backup` is its one
 * reader, and it goes only to the account that wrote it.
 */
export const accountBackups = pgTable(
  "account_backups",
  {
    /** An Oxy account id: no FK (CONVENTIONS.md). */
    accountId: text().primaryKey(),
    /** The instance that wrote it; its signing key verifies `manifest_signature`. */
    instanceId: text()
      .notNull()
      .references(() => clientInstances.id, { onDelete: "cascade" }),
    manifest: jsonb().$type<ArchiveManifest>().notNull(),
    /** HMAC-SHA256 of `BACKUP_KEY_CHECK_MESSAGE` under the backup key, base64. */
    keyCheck: text().notNull(),
    manifestSignature: text().notNull(),
    chunkBlobIds: text().array().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [checkNonEmptyArray("account_backups_chunk_blob_ids_check", t.chunkBlobIds)],
);
