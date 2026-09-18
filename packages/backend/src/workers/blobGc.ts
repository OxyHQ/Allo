/**
 * The blob collector: hourly, delete what nothing will ever reference.
 *
 * `db/expiry.ts` already reaps `blobs.expires_at < now()` every minute; this
 * worker's own contribution is two cases the sweep cannot see:
 *
 * - an unreferenced blob whose uploader was revoked (`deleteCollectableBlobs`,
 *   which runs the dated delete too so the two agree on "collectable");
 * - an UNDATED blob that no event, no pending history offer and no backup
 *   names any more (`dateOrphanedChunkBlobs`): an archive chunk whose offer
 *   row went without releasing it. Ordinarily there are none, because
 *   `runExpirySweep` releases due offers before it deletes them; this pass is
 *   the backstop, and it DATES rather than deletes, so a mistake here costs a
 *   day's grace and not the bytes.
 */

import { getDb, type AlloDatabase } from "../db";
import { deleteCollectableBlobs } from "../db/platform/blobRepository";
import { dateOrphanedChunkBlobs } from "../db/platform/historyRepository";
import { logger } from "../utils/logger";

export const BLOB_GC_INTERVAL_MS = 60 * 60 * 1_000;

export async function runBlobGc(deps: { db?: AlloDatabase; now?: () => Date } = {}): Promise<number> {
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  const orphaned = await dateOrphanedChunkBlobs(now, db);
  const deleted = await deleteCollectableBlobs(now, db);
  const summary = `blob gc: deleted=${deleted.length} orphanedChunksDated=${orphaned.length}`;
  if (deleted.length > 0 || orphaned.length > 0) logger.info(summary);
  else logger.debug(summary);
  return deleted.length;
}

let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<unknown> | undefined;

export function startBlobGc(deps: { db?: AlloDatabase } = {}): void {
  if (timer) return;
  const tick = () => {
    if (inFlight) return;
    inFlight = runBlobGc(deps)
      .catch((error: unknown) => logger.error("blob gc failed", error))
      .finally(() => {
        inFlight = undefined;
      });
  };
  tick();
  timer = setInterval(tick, BLOB_GC_INTERVAL_MS);
  timer.unref?.();
}

export async function stopBlobGc(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = undefined;
  await inFlight;
}
