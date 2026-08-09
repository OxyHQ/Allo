/**
 * Signal Protocol device registry.
 *
 * Ported from `models/Device.ts`. This table holds PUBLIC key material only —
 * identity key, signed pre-key and one-time pre-keys — which is what makes it
 * safe to store at all; no private key of any kind reaches this service.
 */

import { index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, updatedAt } from "@oxyhq/db";

/**
 * One device belonging to one Oxy user.
 *
 * The embedded `signedPreKey` becomes three columns rather than `jsonb`: it is a
 * fixed triple the server hands to a client verbatim, and a missing `signature`
 * is a device nobody can start a session with — a fact worth a `NOT NULL`.
 */
export const devices = pgTable(
  "devices",
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    /** Signal's own device number, 1-based. */
    deviceId: integer().notNull(),
    identityKeyPublic: text().notNull(),
    signedPreKeyId: integer().notNull(),
    signedPreKeyPublic: text().notNull(),
    signedPreKeySignature: text().notNull(),
    registrationId: integer().notNull(),
    lastSeen: timestamptz().notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("devices_user_id_device_id_key").on(t.userId, t.deviceId),
    index("devices_user_id_idx").on(t.userId),
  ],
);

/**
 * One-time pre-keys, as a CHILD TABLE rather than an array column.
 *
 * A pre-key is an individually-meaningful credential that Signal consumes one at
 * a time, so `unique(device_id, key_id)` is a real invariant — the current route
 * replaces the whole array on every write and therefore enforces nothing about
 * duplicate key ids.
 *
 * `routes/devices.ts` excludes these from the device list with
 * `.select("-preKeys")`. That exclusion does NOT survive the port: a
 * `db.select().from(devices)` returns every column of `devices`, and pre-keys
 * are now a separate table nothing joins by accident — which is the safer shape,
 * but the registry in `protectedColumns.ts` still names them so the intent
 * cannot be lost.
 */
export const devicePreKeys = pgTable(
  "device_pre_keys",
  {
    id: text().primaryKey(),
    deviceId: text()
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** Signal's own pre-key id, unique within a device. */
    keyId: integer().notNull(),
    publicKey: text().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("device_pre_keys_device_id_key_id_key").on(t.deviceId, t.keyId),
  ],
);
