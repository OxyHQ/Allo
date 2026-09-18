/**
 * Client instances and their MLS key packages.
 *
 * One instance per installation: an independent Ed25519 signer and an
 * independent MLS leaf. There is no primary device. Design and the enrollment
 * rules are in `docs/platform/api-v1.md`; decisions common to the whole schema
 * are in `CONVENTIONS.md`.
 */

import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, timestamptz, updatedAt } from "@oxy.so/db";
import { INSTANCE_STATUSES, PLATFORMS, PUSH_PROVIDERS } from "@allo/shared-types";
import { checkOneOf } from "./columns";

export type InstanceStatus = (typeof INSTANCE_STATUSES)[number];
export type InstancePlatform = (typeof PLATFORMS)[number];
export type InstancePushProvider = (typeof PUSH_PROVIDERS)[number];

/**
 * `account_id` is an Oxy account id — a foreign SERVICE's primary key — so it
 * carries no foreign key (CONVENTIONS.md).
 *
 * `signing_public_key` is the raw 32-byte Ed25519 public key, base64. Unique
 * per account so the same key cannot enrol twice under one account.
 *
 * `transfer_public_key` is the raw 32-byte X25519 public key, base64, that a
 * donor instance seals an archive key to (`history_offers.sealed_key`). Nullable
 * because Phase 2 rows predate it; such an instance sets it through
 * `PUT /v1/instances/me/transfer-key`, and until then an offer to it is refused
 * with `transfer_key_missing`.
 *
 * `push_token` is a credential for a third party's push service and is
 * registered in `protectedColumns.ts`: it never leaves the process in a
 * response. The pair CHECK keeps a provider and a token together — half a
 * registration would be a device the worker believes it can reach and cannot.
 *
 * Every CHECK below is written over column references only, with no
 * interpolated VALUE, so nothing renders as a `$1` placeholder in the
 * generated migration.
 */
export const clientInstances = pgTable(
  "client_instances",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    appId: text().notNull(),
    platform: text({ enum: PLATFORMS }).notNull(),
    displayName: text().notNull(),
    signingPublicKey: text().notNull(),
    transferPublicKey: text(),
    status: text({ enum: INSTANCE_STATUSES }).notNull().default("pending"),
    /**
     * base64url. Null for the bootstrap instance; issued at a non-first
     * registration and KEPT after approval, because the approval signature is
     * over it and a verifier needs it. Cleared on rejection/revocation.
     */
    enrollmentChallenge: text(),
    /** Null for the bootstrap instance, which nobody approved. */
    approvedByInstanceId: text(),
    approvalSignature: text(),
    enrolledAt: timestamptz(),
    revokedAt: timestamptz(),
    lastSeenAt: timestamptz(),
    pushProvider: text({ enum: PUSH_PROVIDERS }),
    pushToken: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("client_instances_account_id_signing_public_key_key").on(
      t.accountId,
      t.signingPublicKey,
    ),
    index("client_instances_account_id_status_idx").on(t.accountId, t.status),
    checkOneOf("client_instances_platform_check", t.platform, PLATFORMS),
    checkOneOf("client_instances_status_check", t.status, INSTANCE_STATUSES),
    checkOneOf("client_instances_push_provider_check", t.pushProvider, PUSH_PROVIDERS),
    check(
      "client_instances_push_pair_check",
      sql`(${t.pushProvider} is null) = (${t.pushToken} is null)`,
    ),
  ],
);

/**
 * MLS key packages: the public half an instance publishes so others can add it
 * to a group while it is offline. Opaque to the server, handed out at most
 * once (`consumed_at`), and gone with the instance (`ON DELETE CASCADE`).
 *
 * `ref` is the KeyPackageRef, unique server-wide: two instances cannot publish
 * the same package. `data` is registered in `protectedColumns.ts` because it is
 * material only a claimer should receive, never a listing.
 */
export const keyPackages = pgTable(
  "key_packages",
  {
    id: text().primaryKey(),
    instanceId: text()
      .notNull()
      .references(() => clientInstances.id, { onDelete: "cascade" }),
    ciphersuite: integer().notNull(),
    ref: text().notNull().unique("key_packages_ref_key"),
    data: text().notNull(),
    consumedAt: timestamptz(),
    consumedByInstanceId: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("key_packages_instance_id_consumed_at_idx").on(t.instanceId, t.consumedAt),
    check("key_packages_ciphersuite_check", sql`${t.ciphersuite} between 1 and 65535`),
  ],
);
