/**
 * The encrypted account backup: one archive per account on the server,
 * under a key derived from a 12-word recovery phrase the user holds.
 *
 *   enable()   mint the phrase, derive and keep the key, upload the first
 *              backup; the phrase is returned ONCE and never persisted.
 *   refresh()  export → encrypt → upload chunks → PUT (replaces the previous).
 *              Automatic after a sync when ≥ 20 events landed since the last
 *              refresh or it is more than 24 h old, debounced.
 *   disable()  DELETE the backup and forget the key.
 *   restore()  derive the key from the phrase, fetch the backup record, and
 *              REFUSE before any download when `keyCheck` says the phrase is
 *              wrong; then download, decrypt, verify, import, and keep the
 *              key so refreshes continue from this instance.
 */
import { BLOB_SHA256_HEADER, archiveManifestMessage, backupResponseSchema, decodeArchive, encodeArchive, uploadBlobResponseSchema, type ArchiveManifest } from "@allo/shared-types";
import type { Context } from "../context";
import { decryptArchive, encryptArchive } from "../crypto/archive";
import { BACKUP_KEY_BYTES, backupKeyCheck, backupKeyMatches, backupKeyName, deriveBackupKey, generateRecoveryPhrase } from "../crypto/backupKey";
import { signUtf8, verifyEd25519 } from "../crypto/signing";
import { DecryptError, InvalidStateError, NotFoundError, RecoveryPhraseError, TransportError, UntrustedInstanceError } from "../errors";
import { backupStateRecordSchema, type BackupStateRecord } from "../storage/records";
import type { BackupStatus } from "../types";
import { sha256Hex } from "../util/bytes";
import { describeError } from "../util/logger";
import { exportArchive, importArchive } from "../history/archive";

export const BACKUP_AUTO_REFRESH_EVENTS = 20;
export const BACKUP_AUTO_REFRESH_AGE_MS = 24 * 60 * 60 * 1000;
export const BACKUP_AUTO_REFRESH_DEBOUNCE_MS = 10_000;

const INITIAL: BackupStateRecord = { enabled: false, lastBackupAt: null, eventCountAtBackup: 0 };

/** The auto-refresh policy, pure: ≥ 20 events since the last backup, or more than 24 h since it. */
export function backupDue(state: BackupStateRecord, eventCount: number, nowMs: number): boolean {
  if (!state.enabled) return false;
  if (state.lastBackupAt === null) return true;
  if (eventCount - state.eventCountAtBackup >= BACKUP_AUTO_REFRESH_EVENTS) return true;
  return nowMs - Date.parse(state.lastBackupAt) > BACKUP_AUTO_REFRESH_AGE_MS;
}

export class BackupService {
  private state: BackupStateRecord = INITIAL;
  private remote: { exists: boolean; updatedAt: string | null } | null = null;
  private busy = false;
  private statusValue: BackupStatus | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly ctx: Context,
    private readonly debounceMs = BACKUP_AUTO_REFRESH_DEBOUNCE_MS,
  ) {}

  async load(): Promise<void> {
    const stored = await this.ctx.store.getJson("backupState", "state", backupStateRecordSchema);
    if (stored) this.state = stored;
  }

  // ---- status --------------------------------------------------------------

  /** Referentially stable until the `backup` topic emits. */
  status(): BackupStatus {
    if (!this.statusValue) {
      this.statusValue = { enabled: this.state.enabled, lastBackupAt: this.state.lastBackupAt, eventCount: this.state.eventCountAtBackup, remote: this.remote, busy: this.busy };
    }
    return this.statusValue;
  }

  private changed(): void {
    this.statusValue = null;
    this.ctx.emitter.emit("backup");
  }

  private setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.changed();
  }

  private async setState(next: BackupStateRecord): Promise<void> {
    await this.ctx.store.putJson("backupState", "state", next);
    this.state = next;
    this.changed();
  }

  /** Asks the server whether the account has a backup. */
  async refreshStatus(): Promise<void> {
    const { ctx } = this;
    ctx.instance.assertActive();
    const res = await ctx.http.request({ method: "GET", path: "/v1/accounts/me/backup", schema: backupResponseSchema, signer: ctx.signer });
    this.remote = { exists: res.backup !== null, updatedAt: res.backup?.updatedAt ?? null };
    this.changed();
  }

  private async key(): Promise<Uint8Array | undefined> {
    const k = await this.ctx.options.secrets.get(backupKeyName(this.ctx.accountId, this.ctx.options.appId));
    return k && k.length === BACKUP_KEY_BYTES ? k : undefined;
  }

  private totalEvents(): number {
    let n = 0;
    for (const m of this.ctx.model.events.values()) n += m.size;
    return n;
  }

  // ---- enable / refresh / disable ------------------------------------------

  /** Returns the recovery phrase. It is shown once and kept nowhere; only the derived key is stored. */
  async enable(): Promise<string> {
    const { ctx } = this;
    ctx.instance.assertActive();
    if (this.state.enabled) throw new InvalidStateError("backup is already enabled; disable it to get a new phrase");
    const phrase = generateRecoveryPhrase();
    const key = deriveBackupKey(phrase, ctx.accountId);
    const name = backupKeyName(ctx.accountId, ctx.options.appId);
    await ctx.options.secrets.set(name, key);
    await this.setState({ enabled: true, lastBackupAt: null, eventCountAtBackup: 0 });
    try {
      await this.refresh();
    } catch (error) {
      // No backup exists, so the phrase would unlock nothing: roll back rather than hand out a phrase for a backup that failed.
      await ctx.options.secrets.delete(name).catch(() => undefined);
      await this.setState(INITIAL);
      throw error;
    }
    return phrase;
  }

  /** Exports, encrypts, uploads and PUTs; the server replaces the previous backup. */
  async refresh(): Promise<void> {
    const { ctx } = this;
    ctx.instance.assertActive();
    if (!this.state.enabled) throw new InvalidStateError("backup is not enabled");
    const key = await this.key();
    if (!key) throw new InvalidStateError("the backup key is missing from the secret store; disable and enable again");
    await ctx.history.jobs.run(async () => {
      this.setBusy(true);
      try {
        const archive = exportArchive(ctx);
        const plaintext = encodeArchive(archive);
        const chunks = encryptArchive(key, plaintext);
        const chunkBlobIds: string[] = [];
        for (const chunk of chunks) {
          const res = await ctx.http.request({
            method: "POST",
            path: "/v1/blobs",
            rawBody: chunk,
            headers: { [BLOB_SHA256_HEADER]: sha256Hex(chunk) },
            schema: uploadBlobResponseSchema,
            signer: ctx.signer,
          });
          chunkBlobIds.push(res.blobId);
        }
        const manifest: ArchiveManifest = {
          v: 1,
          kind: "backup",
          createdAt: ctx.nowIso(),
          conversationCount: archive.conversations.length,
          eventCount: archive.events.length,
          chunkBlobIds,
          plaintextSha256: sha256Hex(plaintext),
        };
        const res = await ctx.http.request({
          method: "PUT",
          path: "/v1/accounts/me/backup",
          body: { manifest, keyCheck: backupKeyCheck(key), manifestSignature: signUtf8(ctx.signer.key, archiveManifestMessage(manifest)) },
          schema: backupResponseSchema,
          signer: ctx.signer,
        });
        this.remote = { exists: true, updatedAt: res.backup?.updatedAt ?? manifest.createdAt };
        await this.setState({ enabled: true, lastBackupAt: res.backup?.updatedAt ?? manifest.createdAt, eventCountAtBackup: this.totalEvents() });
        ctx.log.info?.("backup refreshed", { conversations: manifest.conversationCount, events: manifest.eventCount, chunks: chunkBlobIds.length });
      } finally {
        this.setBusy(false);
      }
    });
  }

  /** DELETEs the backup and forgets the key. A backup that is already gone is not an error. */
  async disable(): Promise<void> {
    const { ctx } = this;
    ctx.instance.assertActive();
    try {
      await ctx.http.request({ method: "DELETE", path: "/v1/accounts/me/backup", signer: ctx.signer });
    } catch (error) {
      if (!(error instanceof TransportError && error.status === 404)) throw error;
    }
    await ctx.options.secrets.delete(backupKeyName(ctx.accountId, ctx.options.appId));
    this.remote = { exists: false, updatedAt: null };
    await this.setState(INITIAL);
  }

  // ---- restore -------------------------------------------------------------

  /** Restores the account's backup with its phrase. A wrong phrase is refused by `keyCheck` before anything is downloaded. */
  async restore(phrase: string): Promise<void> {
    const { ctx } = this;
    ctx.instance.assertActive();
    const key = deriveBackupKey(phrase, ctx.accountId); // RecoveryPhraseError on a malformed phrase
    const res = await ctx.http.request({ method: "GET", path: "/v1/accounts/me/backup", schema: backupResponseSchema, signer: ctx.signer });
    const backup = res.backup;
    this.remote = { exists: backup !== null, updatedAt: backup?.updatedAt ?? null };
    this.changed();
    if (!backup) throw new NotFoundError("account backup");
    if (!backupKeyMatches(key, backup.keyCheck)) throw new RecoveryPhraseError("the phrase does not unlock this account's backup");
    if (backup.accountId !== ctx.accountId) throw new InvalidStateError("the backup belongs to another account");
    if (backup.manifest.kind !== "backup") throw new InvalidStateError("the backup carries a manifest that is not a backup manifest");
    if (!ctx.instance.ownInstance(backup.instanceId)) await ctx.instance.refresh();
    const writer = ctx.instance.ownInstance(backup.instanceId);
    if (!writer || writer.accountId !== ctx.accountId) throw new UntrustedInstanceError(backup.instanceId, "the writing instance is not an instance of this account");
    if (!verifyEd25519(writer.signingPublicKey, archiveManifestMessage(backup.manifest), backup.manifestSignature)) {
      throw new UntrustedInstanceError(backup.instanceId, "manifest signature does not verify");
    }
    await ctx.history.jobs.run(async () => {
      this.setBusy(true);
      try {
        const chunks = await ctx.history.downloadChunks(backup.manifest.chunkBlobIds, () => undefined);
        const plaintext = decryptArchive(key, chunks);
        if (sha256Hex(plaintext) !== backup.manifest.plaintextSha256) throw new DecryptError("backup digest does not match the signed manifest");
        const archive = decodeArchive(plaintext);
        const result = await importArchive(ctx, archive);
        await ctx.options.secrets.set(backupKeyName(ctx.accountId, ctx.options.appId), key);
        await this.setState({ enabled: true, lastBackupAt: backup.updatedAt, eventCountAtBackup: this.totalEvents() });
        ctx.log.info?.("backup restored", { conversations: result.conversations, events: result.events });
      } finally {
        this.setBusy(false);
      }
    });
  }

  // ---- automatic refresh ---------------------------------------------------

  /** Called after each sync. Debounced so a burst of deliveries becomes one refresh. */
  afterSync(): void {
    const { ctx } = this;
    if (this.stopped || !ctx.instance.isActive || this.busy) return;
    if (!backupDue(this.state, this.totalEvents(), ctx.now())) return;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped || !backupDue(this.state, this.totalEvents(), ctx.now())) return;
      void this.refresh().catch((error) => ctx.log.warn?.("automatic backup refresh failed", { error: describeError(error) }));
    }, this.debounceMs);
  }

  start(): void {
    this.stopped = false;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
