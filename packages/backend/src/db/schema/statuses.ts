/**
 * Status updates: the ciphertext, who it was sealed to, and who has seen it.
 *
 * Three tables and a deadline. The server holds a body it cannot open, a
 * thirty-two byte key per recipient device that opens only with that device's
 * transfer private key, and the fact of who viewed — all of which is in
 * `threat-model.md` §5, because the audience is something the server
 * necessarily learns in order to deliver.
 *
 * `statuses.payload` is AES-256-GCM ciphertext stored INLINE rather than as a
 * blob: the envelope is a few hundred bytes (what kind, the words, the key and
 * digest of any media), and a blob would be a second round trip for every
 * status in a list. The media itself is a blob, named inside that envelope,
 * fetched only when somebody opens the update.
 *
 * `status_blob_ids` duplicates what the ciphertext already names, for the same
 * reason `history_offers.chunk_blob_ids` does: retention has to be answerable
 * with `blobs.id = any(...)` by a server that cannot read the envelope.
 *
 * Every row has a deadline, so every table here is registered in
 * `EXPIRY_SWEEP_TARGETS` with a leading index on the column the sweep reads.
 */

import { index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { bytea, createdAt, timestamptz } from "@oxy.so/db";
import { checkOneOf } from "./columns";

export const STATUS_STATES = ["live", "deleted"] as const;
export type StatusState = (typeof STATUS_STATES)[number];

export const statuses = pgTable(
  "statuses",
  {
    id: text().primaryKey(),
    authorAccountId: text().notNull(),
    /** The instance that wrote and signed it. A recipient verifies against this instance's published key. */
    authorInstanceId: text().notNull(),
    /** AES-256-GCM ciphertext of the status envelope, under the per-status key. */
    payload: bytea().notNull(),
    nonce: bytea().notNull(),
    /** Of the ciphertext, so a recipient verifies before decrypting. */
    sha256: text().notNull(),
    /** The blobs the envelope names, so the collector can see them without reading it. */
    blobIds: text().array().notNull().default([]),
    signature: text().notNull(),
    /** The author's own idempotency key, so a retried post is the same status. */
    idempotencyKey: text().notNull(),
    state: text({ enum: STATUS_STATES }).notNull().default("live"),
    createdAt: createdAt(),
    /** 24 hours after it was posted, or sooner if the author deleted it. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    uniqueIndex("statuses_author_instance_idempotency_key").on(t.authorInstanceId, t.idempotencyKey),
    // The sweep reads this, and the listing filters on it.
    index("statuses_expires_at_idx").on(t.expiresAt),
    index("statuses_author_account_id_created_at_idx").on(t.authorAccountId, t.createdAt),
    checkOneOf("statuses_state_check", t.state, STATUS_STATES),
  ],
);

/**
 * The per-status key, HPKE-sealed to ONE instance's transfer key.
 *
 * One row per recipient device. The server can hand each device its own sealed
 * copy and open none of them; deleting the row is what stops delivery, and the
 * sweep deletes them with the status.
 */
export const statusKeys = pgTable(
  "status_keys",
  {
    id: text().primaryKey(),
    statusId: text()
      .notNull()
      .references(() => statuses.id, { onDelete: "cascade" }),
    /** The recipient device. */
    instanceId: text().notNull(),
    /** Its account, so an inbox read is one index probe rather than a join through instances. */
    accountId: text().notNull(),
    sealedKey: text().notNull(),
    createdAt: createdAt(),
    /** The status's own deadline, copied so the sweep can reap keys without a join. */
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    uniqueIndex("status_keys_status_id_instance_id_key").on(t.statusId, t.instanceId),
    index("status_keys_instance_id_expires_at_idx").on(t.instanceId, t.expiresAt),
    index("status_keys_expires_at_idx").on(t.expiresAt),
  ],
);

/**
 * Who has seen a status.
 *
 * One row per viewing ACCOUNT, not per device: the author is told a person
 * saw it, not which phone they saw it on. A viewer whose receipts are off
 * writes a row with `published = false`, so the count is honest and the name
 * is not shown — the author sees "seen by 4" and three names, and cannot tell
 * which of the two the fourth is.
 */
export const statusViews = pgTable(
  "status_views",
  {
    id: text().primaryKey(),
    statusId: text()
      .notNull()
      .references(() => statuses.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    /** Whether this viewer publishes their name with the view. */
    published: text({ enum: ["yes", "no"] }).notNull().default("yes"),
    viewedAt: timestamptz().notNull(),
    expiresAt: timestamptz().notNull(),
  },
  (t) => [
    uniqueIndex("status_views_status_id_account_id_key").on(t.statusId, t.accountId),
    index("status_views_expires_at_idx").on(t.expiresAt),
    checkOneOf("status_views_published_check", t.published, ["yes", "no"] as const),
  ],
);
