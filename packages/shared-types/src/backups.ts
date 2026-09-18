/**
 * Account backups: one encrypted archive per account, unlocked by a
 * recovery phrase the user holds and the server never sees. A fresh
 * installation with no other device left can still get its history back.
 *
 * Backup key: 12-word BIP39 (English) phrase → 128-bit entropy →
 * `HKDF-SHA256(ikm = entropy, salt = BACKUP_KDF_SALT, info = accountId)` →
 * 32-byte AES-256 key. `keyCheck` is `HMAC-SHA256(key, BACKUP_KEY_CHECK_MESSAGE)`,
 * so a client can refuse a mistyped phrase before it downloads a single chunk.
 * A wrong `keyCheck` proves nothing to the server — it stores and returns it.
 */
import { z } from "zod";
import { archiveManifestSchema } from "./archive";
import { accountIdSchema, ed25519SignatureSchema, instanceIdSchema, isoDateSchema } from "./common";

/** HMAC-SHA256 output, base64: exactly 32 bytes → 44 characters. */
export const backupKeyCheckSchema = z.base64().length(44);

export const accountBackupSchema = z.object({
  accountId: accountIdSchema,
  /** The instance that wrote it; its key verifies `manifestSignature`. */
  instanceId: instanceIdSchema,
  manifest: archiveManifestSchema,
  keyCheck: backupKeyCheckSchema,
  manifestSignature: ed25519SignatureSchema,
  updatedAt: isoDateSchema,
});
export type AccountBackup = z.infer<typeof accountBackupSchema>;

/**
 * `PUT /v1/accounts/me/backup` — replaces the previous backup. The manifest
 * is a `backup` manifest: the kind is inside the signed bytes, so a transfer
 * manifest cannot be replayed here.
 */
export const putBackupRequestSchema = z
  .object({
    manifest: archiveManifestSchema,
    keyCheck: backupKeyCheckSchema,
    manifestSignature: ed25519SignatureSchema,
  })
  .superRefine((v, ctx) => {
    if (v.manifest.kind !== "backup") {
      ctx.addIssue({ code: "custom", path: ["manifest", "kind"], message: "a backup carries a backup manifest" });
    }
  });
export type PutBackupRequest = z.infer<typeof putBackupRequestSchema>;

/** `PUT` and `GET /v1/accounts/me/backup`. `null` from `GET` when the account has none. */
export const backupResponseSchema = z.object({
  backup: accountBackupSchema.nullable(),
});
export type BackupResponse = z.infer<typeof backupResponseSchema>;
