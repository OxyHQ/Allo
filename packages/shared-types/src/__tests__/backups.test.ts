import { describe, expect, it } from "vitest";
import {
  accountBackupSchema,
  backupKeyCheckSchema,
  backupResponseSchema,
  putBackupRequestSchema,
  type AccountBackup,
  type PutBackupRequest,
} from "../backups";
import { ISO, MANIFEST, OBJECT_ID, PUBKEY, SIGNATURE, UUID_V7 } from "./fixtures";

const BACKUP_MANIFEST = { ...MANIFEST, kind: "backup" as const };
/** HMAC-SHA256 output: 32 bytes → 44 base64 chars. */
const KEY_CHECK = Buffer.alloc(32, 6).toString("base64");

const backup: AccountBackup = {
  accountId: OBJECT_ID,
  instanceId: UUID_V7,
  manifest: BACKUP_MANIFEST,
  keyCheck: KEY_CHECK,
  manifestSignature: SIGNATURE,
  updatedAt: ISO,
};

const request: PutBackupRequest = {
  manifest: BACKUP_MANIFEST,
  keyCheck: KEY_CHECK,
  manifestSignature: SIGNATURE,
};

describe("backupKeyCheckSchema", () => {
  it("is exactly 32 bytes of base64", () => {
    expect(backupKeyCheckSchema.safeParse(KEY_CHECK).success).toBe(true);
    expect(backupKeyCheckSchema.safeParse(PUBKEY).success).toBe(true);
    expect(backupKeyCheckSchema.safeParse(SIGNATURE).success).toBe(false);
    expect(backupKeyCheckSchema.safeParse(Buffer.alloc(30, 6).toString("base64")).success).toBe(false);
    expect(backupKeyCheckSchema.safeParse("").success).toBe(false);
  });
});

describe("accountBackupSchema", () => {
  it("accepts a backup record", () => {
    expect(accountBackupSchema.safeParse(backup).success).toBe(true);
  });
  it("rejects a missing field, a wrong key check length, a short signature and a non-manifest", () => {
    const { instanceId: _omit, ...missing } = backup;
    expect(accountBackupSchema.safeParse(missing).success).toBe(false);
    expect(accountBackupSchema.safeParse({ ...backup, keyCheck: SIGNATURE }).success).toBe(false);
    expect(accountBackupSchema.safeParse({ ...backup, manifestSignature: PUBKEY }).success).toBe(false);
    expect(accountBackupSchema.safeParse({ ...backup, manifest: { v: 1, kind: "backup" } }).success).toBe(false);
    expect(accountBackupSchema.safeParse({ ...backup, updatedAt: "yesterday" }).success).toBe(false);
  });
});

describe("putBackupRequestSchema", () => {
  it("accepts a backup manifest with a key check and a signature", () => {
    expect(putBackupRequestSchema.safeParse(request).success).toBe(true);
  });
  it("refuses a transfer manifest: the kind is inside the signed bytes and must say backup", () => {
    const r = putBackupRequestSchema.safeParse({ ...request, manifest: MANIFEST });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join("."))).toContain("manifest.kind");
  });
  it("refuses an unknown kind, a missing key check, a wrong key check length and a wrong signature length", () => {
    expect(putBackupRequestSchema.safeParse({ ...request, manifest: { ...MANIFEST, kind: "export" } }).success).toBe(false);
    const { keyCheck: _omit, ...missing } = request;
    expect(putBackupRequestSchema.safeParse(missing).success).toBe(false);
    expect(putBackupRequestSchema.safeParse({ ...request, keyCheck: SIGNATURE }).success).toBe(false);
    expect(putBackupRequestSchema.safeParse({ ...request, manifestSignature: PUBKEY }).success).toBe(false);
    expect(putBackupRequestSchema.safeParse({ ...request, manifest: { ...BACKUP_MANIFEST, chunkBlobIds: [] } }).success).toBe(false);
  });
});

describe("backupResponseSchema", () => {
  it("wraps a backup or null, never an absent field", () => {
    expect(backupResponseSchema.safeParse({ backup }).success).toBe(true);
    expect(backupResponseSchema.safeParse({ backup: null }).success).toBe(true);
    expect(backupResponseSchema.safeParse({}).success).toBe(false);
    expect(backupResponseSchema.safeParse(backup).success).toBe(false);
    expect(backupResponseSchema.safeParse({ backup: { ...backup, keyCheck: "x" } }).success).toBe(false);
  });
});
