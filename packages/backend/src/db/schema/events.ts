/**
 * The append-only, per-conversation event log.
 *
 * Every `payload` is ciphertext the server cannot read, except a `control`
 * event, which the server writes itself (`{ t: "instance_revoked", … }` and
 * friends — `controlEventSchema` in `@allo/shared-types`). `payload` is
 * registered in `protectedColumns.ts` so a listing cannot serialise it by
 * accident; the two readers that legitimately return it (`GET …/events` and
 * `GET /v1/sync`) name it explicitly.
 */

import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { bytea, createdAt } from "@oxy.so/db";
import { EVENT_KINDS } from "@allo/shared-types";
import { checkOneOf } from "./columns";
import { conversations } from "./conversations";

export type EventKind = (typeof EVENT_KINDS)[number];

/**
 * `seq` is dense per conversation, from 1, assigned under the conversation
 * row's `FOR UPDATE` lock; `(conversation_id, seq)` is unique so a bug in that
 * assignment is a unique violation rather than a silent gap.
 *
 * `(sender_instance_id, idempotency_key)` is unique WHERE the key is not null:
 * a client retry lands on the original event. `control` events carry neither.
 *
 * `blob_ids` is what the sender DECLARED; the server never interprets it. It
 * exists so the blob collector keeps what an event references; the GIN index
 * on it is what lets "is this blob named by any event?" be an index probe
 * rather than a scan, which the archive-chunk release and the collector's
 * orphan pass (`db/platform/historyRepository.ts`, `workers/blobGc.ts`) ask
 * per blob.
 */
export const conversationEvents = pgTable(
  "conversation_events",
  {
    id: text().primaryKey(),
    conversationId: text()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: bigint({ mode: "number" }).notNull(),
    kind: text({ enum: EVENT_KINDS }).notNull(),
    epoch: bigint({ mode: "number" }).notNull(),
    /** An Oxy account id, or `allo:server` (`SERVER_SENDER_ID`) for `control`. */
    senderAccountId: text().notNull(),
    senderInstanceId: text(),
    idempotencyKey: text(),
    payload: bytea().notNull(),
    blobIds: text().array().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("conversation_events_conversation_id_seq_key").on(t.conversationId, t.seq),
    uniqueIndex("conversation_events_sender_instance_id_idempotency_key_key")
      .on(t.senderInstanceId, t.idempotencyKey)
      .where(sql`idempotency_key is not null`),
    index("conversation_events_blob_ids_gin_idx").using("gin", t.blobIds),
    checkOneOf("conversation_events_kind_check", t.kind, EVENT_KINDS),
    check("conversation_events_seq_check", sql`${t.seq} >= 1`),
    check("conversation_events_epoch_check", sql`${t.epoch} >= 0`),
  ],
);
