/** Valid wire values the suites share. Each is the shape the schema names, and nothing looser. */
import type { ArchiveManifest } from "../archive";

export const UUID_V7 = "0192a1b2-3c4d-7e5f-8a9b-0c1d2e3f4a5b";
export const OBJECT_ID = "507f1f77bcf86cd799439011";
export const OBJECT_ID_2 = "507f191e810c19729de860ea";
export const BLOB_HEX_ID = "a".repeat(64);
export const ISO = "2026-09-17T10:20:30.123Z";
export const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** base64 of 32 bytes: 44 chars. */
export const PUBKEY = Buffer.alloc(32, 1).toString("base64");
/** base64 of a second 32-byte key (the X25519 transfer key): 44 chars. */
export const XPUBKEY = Buffer.alloc(32, 4).toString("base64");
/** base64 of 64 bytes: 88 chars. */
export const SIGNATURE = Buffer.alloc(64, 2).toString("base64");
/** base64url of 32 bytes: 43 chars, unpadded. */
export const CHALLENGE = Buffer.alloc(32, 3).toString("base64url");
export const B64 = Buffer.from("hello world").toString("base64");
/** base64 of a stand-in serialized GroupInfo (the server never reads it). */
export const GROUP_INFO = Buffer.from("mls_group_info").toString("base64");

/** A valid `transfer` manifest of two chunks. Spread `{ ...MANIFEST, kind: "backup" }` for the other kind. */
export const MANIFEST: ArchiveManifest = {
  v: 1,
  kind: "transfer",
  createdAt: ISO,
  conversationCount: 2,
  eventCount: 2,
  chunkBlobIds: [BLOB_HEX_ID, UUID_V7],
  plaintextSha256: SHA256,
};
