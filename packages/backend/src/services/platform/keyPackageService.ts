/**
 * Key package stock (`docs/platform/api-v1.md`, Key packages).
 */

import type { ClaimKeyPackagesResponse, UploadKeyPackagesRequest, UploadKeyPackagesResponse } from "@allo/shared-types";
import { getDb, type AlloDatabase } from "../../db";
import { claimKeyPackage, countAvailableKeyPackages, insertKeyPackages } from "../../db/platform/keyPackageRepository";
import { getRealtime } from "../../runtime/realtime";
import { AlloHttpError } from "../../utils/httpErrors";

/** Below this many unconsumed packages an instance is told to upload more. */
export const KEY_PACKAGE_LOW_WATER_MARK = 5;

/**
 * `GET /v1/key-packages`: the unconsumed stock, readable without uploading.
 *
 * `uploadKeyPackages` answers the same number, which used to be the only way
 * to learn it — so a client starting up had to assume zero and upload a full
 * target's worth every time. Nothing expires a key package and no sweep
 * collects one, so that assumption grew both stores without bound.
 */
export async function countKeyPackageStock(
  instanceId: string,
  deps: { db?: AlloDatabase } = {},
): Promise<UploadKeyPackagesResponse> {
  return { available: await countAvailableKeyPackages(instanceId, deps.db ?? getDb()) };
}

export async function uploadKeyPackages(
  instanceId: string,
  request: UploadKeyPackagesRequest,
  deps: { db?: AlloDatabase } = {},
): Promise<UploadKeyPackagesResponse> {
  const db = deps.db ?? getDb();
  const refs = request.keyPackages.map((upload) => upload.ref);
  if (new Set(refs).size !== refs.length) {
    throw new AlloHttpError("idempotency_conflict", "A ref appears twice in the upload");
  }
  const result = await insertKeyPackages(instanceId, request.keyPackages, db);
  if (result.foreignRefs.length > 0) {
    throw new AlloHttpError("idempotency_conflict", "A ref is already held by another instance", {
      refs: result.foreignRefs,
    });
  }
  return { available: await countAvailableKeyPackages(instanceId, db) };
}

/**
 * One package per requested instance, all in one transaction. An instance
 * with nothing left lands in `missing`. Afterwards, every instance whose
 * stock dropped below the low-water mark is nudged.
 */
export async function claimKeyPackages(
  claimerInstanceId: string,
  instanceIds: readonly string[],
  deps: { db?: AlloDatabase } = {},
): Promise<ClaimKeyPackagesResponse> {
  const db = deps.db ?? getDb();
  const unique = [...new Set(instanceIds)];
  const claimed = await db.transaction(async (tx) => {
    const out: ClaimKeyPackagesResponse = { keyPackages: [], missing: [] };
    for (const instanceId of unique) {
      const row = await claimKeyPackage(instanceId, claimerInstanceId, tx);
      if (row) out.keyPackages.push(row);
      else out.missing.push(instanceId);
    }
    return out;
  });

  const realtime = getRealtime();
  for (const pkg of claimed.keyPackages) {
    const available = await countAvailableKeyPackages(pkg.instanceId, db);
    if (available < KEY_PACKAGE_LOW_WATER_MARK) realtime.keyPackagesLow(pkg.instanceId, { available });
  }
  return claimed;
}
