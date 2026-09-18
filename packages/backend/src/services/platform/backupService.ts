/**
 * Account backups (`docs/platform/api-v1.md`, Backups): one encrypted archive
 * per account, unlocked by a recovery phrase the server never sees.
 *
 * `PUT` replaces the previous backup whole. The manifest is a `backup`
 * manifest (the schema refuses anything else, and the kind is inside the
 * signed bytes), every chunk blob exists and belongs to the account, and the
 * signature verifies against the WRITING instance — the one making the
 * request — so a later reader can check it against that instance's published
 * key. `keyCheck` is stored and returned as given: it is for the client, and
 * a wrong one proves nothing to the server.
 *
 * Retention: the new chunks are retained (`expires_at = null`); the previous
 * backup's chunks the new one does not name are dated a day out, unless a
 * pending offer or an event still names them. `DELETE` releases them the same
 * way. The recovery phrase itself is never sent here.
 */

import type { AccountBackup, PutBackupRequest } from "@allo/shared-types";
import { getDb, type AlloDatabase } from "../../db";
import { deleteBackup, findBackupByAccount, putBackup } from "../../db/platform/historyRepository";
import { findInstanceById } from "../../db/platform/instanceRepository";
import { AlloHttpError } from "../../utils/httpErrors";
import { requireManifestSignature, requireOwnChunkBlobs, type Caller } from "./historyService";
import { toAccountBackup } from "./wire";

export interface BackupServiceDeps {
  db?: AlloDatabase;
  now?: () => Date;
}

export async function putAccountBackup(writer: Caller, request: PutBackupRequest, deps: BackupServiceDeps = {}): Promise<AccountBackup> {
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  const writerRow = await findInstanceById(writer.id, db);
  if (!writerRow || writerRow.status !== "active") throw new AlloHttpError("instance_not_active", "Only an active instance may write a backup");

  await requireOwnChunkBlobs(writer.accountId, request.manifest.chunkBlobIds, db);
  requireManifestSignature(request.manifest, request.manifestSignature, writerRow);

  const row = await db.transaction((tx) =>
    putBackup(
      {
        accountId: writer.accountId,
        instanceId: writer.id,
        manifest: request.manifest,
        keyCheck: request.keyCheck,
        manifestSignature: request.manifestSignature,
        now,
      },
      tx,
    ),
  );
  return toAccountBackup(row);
}

/** The account's backup, or `null` when it has none — a fresh install asks this before it offers to restore. */
export async function getAccountBackup(accountId: string, deps: BackupServiceDeps = {}): Promise<AccountBackup | null> {
  const row = await findBackupByAccount(accountId, deps.db ?? getDb());
  return row ? toAccountBackup(row) : null;
}

/** Delete the backup and release its chunks; `backup_not_found` when there is none. */
export async function deleteAccountBackup(accountId: string, deps: BackupServiceDeps = {}): Promise<void> {
  const db = deps.db ?? getDb();
  const row = await db.transaction((tx) => deleteBackup(accountId, tx));
  if (!row) throw new AlloHttpError("backup_not_found", "The account has no backup");
}
