/**
 * `key_packages` — publish, count, and the one-at-a-time claim.
 *
 * `data` is a protected column: it is returned by {@link claimKeyPackage}
 * only, because a claim is the one operation that is supposed to hand the
 * package to somebody, and it hands it to exactly one somebody.
 */

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { uuidv7 } from "@oxy.so/db";
import type { KeyPackageUpload } from "@allo/shared-types";
import { getDb, type AlloDatabaseOrTransaction } from "../index";
import { requireTransaction } from "../moderation/transactionGuard";
import { clientInstances } from "../schema/instances";
import { keyPackages } from "../schema/instances";

export interface InsertKeyPackagesResult {
  inserted: number;
  /** Refs that already existed and belong to ANOTHER instance: a real conflict. */
  foreignRefs: string[];
}

/**
 * Insert what is new. A ref this instance already published is a retry and
 * is skipped silently; a ref another instance holds is reported so the caller
 * can refuse — a KeyPackageRef is a hash of the package, and two instances
 * cannot have generated the same one honestly.
 */
export async function insertKeyPackages(
  instanceId: string,
  uploads: readonly KeyPackageUpload[],
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<InsertKeyPackagesResult> {
  if (uploads.length === 0) return { inserted: 0, foreignRefs: [] };
  const inserted = await db
    .insert(keyPackages)
    .values(
      uploads.map((upload) => ({
        id: uuidv7(),
        instanceId,
        ciphersuite: upload.ciphersuite,
        ref: upload.ref,
        data: upload.data,
      })),
    )
    .onConflictDoNothing({ target: keyPackages.ref })
    .returning({ ref: keyPackages.ref });
  if (inserted.length === uploads.length) return { inserted: inserted.length, foreignRefs: [] };

  const landed = new Set(inserted.map((row) => row.ref));
  const skipped = uploads.map((upload) => upload.ref).filter((ref) => !landed.has(ref));
  const owners = await db
    .select({ ref: keyPackages.ref, instanceId: keyPackages.instanceId })
    .from(keyPackages)
    .where(inArray(keyPackages.ref, skipped));
  const foreignRefs = owners.filter((row) => row.instanceId !== instanceId).map((row) => row.ref);
  return { inserted: inserted.length, foreignRefs };
}

export async function countAvailableKeyPackages(
  instanceId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(keyPackages)
    .where(and(eq(keyPackages.instanceId, instanceId), isNull(keyPackages.consumedAt)));
  return row?.total ?? 0;
}

export interface ClaimedKeyPackageRow {
  instanceId: string;
  ciphersuite: number;
  ref: string;
  data: string;
}

/**
 * Consume ONE unconsumed package of `instanceId`, or null when it has none.
 *
 * `FOR UPDATE SKIP LOCKED` in the subselect is what makes two concurrent
 * claimers take two different packages rather than one of them waiting on the
 * other and then re-reading the same row. Only an `active` instance's
 * packages are claimable: a revoked one is not addable to a group, and a
 * pending one is not yet anybody's.
 *
 * Transactional so a claim for several instances is all-or-nothing with the
 * caller's other writes.
 */
export async function claimKeyPackage(
  instanceId: string,
  claimerInstanceId: string,
  db: AlloDatabaseOrTransaction,
): Promise<ClaimedKeyPackageRow | null> {
  const tx = requireTransaction(db, `claimKeyPackage(${instanceId})`);
  const candidate = tx
    .select({ id: keyPackages.id })
    .from(keyPackages)
    .innerJoin(clientInstances, eq(clientInstances.id, keyPackages.instanceId))
    .where(
      and(
        eq(keyPackages.instanceId, instanceId),
        isNull(keyPackages.consumedAt),
        eq(clientInstances.status, "active"),
      ),
    )
    .orderBy(asc(keyPackages.createdAt), asc(keyPackages.id))
    .limit(1)
    .for("update", { skipLocked: true, of: keyPackages });

  const [claimed] = await tx
    .update(keyPackages)
    .set({ consumedAt: new Date(), consumedByInstanceId: claimerInstanceId })
    .where(inArray(keyPackages.id, candidate))
    .returning({
      instanceId: keyPackages.instanceId,
      ciphersuite: keyPackages.ciphersuite,
      ref: keyPackages.ref,
      data: keyPackages.data,
    });
  return claimed ?? null;
}
