/**
 * The blob collector: hourly, delete what nothing will ever reference.
 *
 * `db/expiry.ts` already reaps `blobs.expires_at < now()` every minute; this
 * worker's own contribution is the case the sweep cannot see — an
 * unreferenced blob whose uploader was revoked — and it runs the dated delete
 * too so the two agree on what "collectable" means (`deleteCollectableBlobs`).
 */

import { getDb, type AlloDatabase } from "../db";
import { deleteCollectableBlobs } from "../db/platform/blobRepository";
import { logger } from "../utils/logger";

export const BLOB_GC_INTERVAL_MS = 60 * 60 * 1_000;

export async function runBlobGc(deps: { db?: AlloDatabase; now?: () => Date } = {}): Promise<number> {
  const deleted = await deleteCollectableBlobs((deps.now ?? (() => new Date()))(), deps.db ?? getDb());
  const summary = `blob gc: deleted=${deleted.length}`;
  if (deleted.length > 0) logger.info(summary);
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
