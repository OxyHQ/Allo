/**
 * The history archive: everything one instance knows, packed so another
 * instance of the same account (a transfer) or a future installation (a
 * backup) can import it. The archive is PLAINTEXT that only ever exists on
 * a device; what the server stores is its chunked AES-256-GCM ciphertext
 * plus a signed {@link ArchiveManifest} describing the chunks. The server is
 * not a party to the archive's versioning — `v` is negotiated by clients.
 *
 * Encryption, chunk by chunk (the client does this, the server checks nothing):
 *
 *   1. `encodeArchive` → UTF-8 JSON bytes; `plaintextSha256` is their digest.
 *   2. Split into pieces of at most {@link ARCHIVE_CHUNK_MAX_BYTES}.
 *   3. Each piece is AES-256-GCM under the 32-byte archive key with a random
 *      12-byte nonce PREFIXED to the ciphertext, and the AAD
 *      {@link archiveChunkAad}`(i, n)` — index and total — so a chunk cannot
 *      be dropped, duplicated or reordered without the decryption failing.
 *   4. Each chunk is uploaded as one blob; `chunkBlobIds` lists them in order.
 *
 * The archive key travels sealed: to a transfer recipient's X25519 key
 * (HPKE, info {@link HISTORY_KEY_SEAL_INFO}), or, for a backup, it IS the key
 * derived from the recovery phrase (salt {@link BACKUP_KDF_SALT}).
 */
import { z } from "zod";
import { appMessageSchema } from "./appMessage";
import {
  accountIdSchema,
  appIdSchema,
  base64Schema,
  blobIdSchema,
  conversationIdSchema,
  eventIdSchema,
  instanceIdSchema,
  isoDateSchema,
  nonNegativeIntSchema,
  sha256HexSchema,
} from "./common";
import { conversationKindSchema } from "./conversations";
import { senderAccountIdSchema } from "./events";

export const ARCHIVE_VERSION = 1;

/** Plaintext bytes per encrypted chunk, at most. 4 MiB. */
export const ARCHIVE_CHUNK_MAX_BYTES = 4 * 1024 * 1024;
/** A manifest lists at most this many chunks: 512 × 4 MiB = 2 GiB of history. */
export const ARCHIVE_MAX_CHUNKS = 512;

/** The AAD of chunk `index` of `total`: `"allo-archive-v1:" + index + "/" + total`. */
export const ARCHIVE_CHUNK_AAD_PREFIX = "allo-archive-v1:";
export function archiveChunkAad(index: number, total: number): string {
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || total < 1 || index >= total) {
    throw new RangeError("chunk index must be an integer in [0, total)");
  }
  return `${ARCHIVE_CHUNK_AAD_PREFIX}${index}/${total}`;
}

/** HPKE `info` when a donor seals the archive key to a recipient's transfer key. */
export const HISTORY_KEY_SEAL_INFO = "allo-history-key-v1";
/** The UTF-8 string a backup's `keyCheck` is the HMAC-SHA256 of, under the backup key. */
export const BACKUP_KEY_CHECK_MESSAGE = "allo-backup-key-check-v1";
/** HKDF-SHA256 salt of the backup key: `HKDF(ikm = phrase entropy, salt, info = accountId)`. */
export const BACKUP_KDF_SALT = "allo-backup-v1";

/** A 32-byte AES-256 key, base64 (44 chars). */
const aesKeySchema = z.base64().length(44);
/** An AES-GCM nonce, base64. 12 bytes is the norm; the bound leaves room. */
const aesNonceSchema = base64Schema(64);

export const MAX_ARCHIVE_TITLE_LENGTH = 128;

export const archiveConversationSchema = z.object({
  id: conversationIdSchema,
  kind: conversationKindSchema,
  appId: appIdSchema,
  /** The E2EE name the exporting instance knew, `null` when it knew none. */
  title: z.string().max(MAX_ARCHIVE_TITLE_LENGTH).nullable(),
  memberAccountIds: z.array(accountIdSchema),
  createdAt: isoDateSchema,
});
export type ArchiveConversation = z.infer<typeof archiveConversationSchema>;

/** One decrypted timeline event: the {@link AppMessage} itself, never MLS ciphertext. */
export const archiveEventSchema = z.object({
  conversationId: conversationIdSchema,
  eventId: eventIdSchema,
  seq: nonNegativeIntSchema,
  senderAccountId: senderAccountIdSchema,
  /** `null` when the sender was the server (a control event) or unknown. */
  senderInstanceId: instanceIdSchema.nullable(),
  sentAt: isoDateSchema,
  message: appMessageSchema,
});
export type ArchiveEvent = z.infer<typeof archiveEventSchema>;

const archiveMediaKeyFieldsSchema = z.object({
  blobId: blobIdSchema,
  key: aesKeySchema,
  nonce: aesNonceSchema,
  /** Of the CIPHERTEXT blob, as uploaded. */
  sha256: sha256HexSchema,
});

/** The key material to open one media blob (and its thumbnail, when there is one). */
export const archiveMediaKeySchema = archiveMediaKeyFieldsSchema.extend({
  conversationId: conversationIdSchema,
  thumbnail: archiveMediaKeyFieldsSchema.optional(),
});
export type ArchiveMediaKey = z.infer<typeof archiveMediaKeySchema>;

export const archiveV1Schema = z.object({
  v: z.literal(ARCHIVE_VERSION),
  createdAt: isoDateSchema,
  accountId: accountIdSchema,
  appId: appIdSchema,
  conversations: z.array(archiveConversationSchema),
  events: z.array(archiveEventSchema),
  mediaKeys: z.array(archiveMediaKeySchema),
});
export type ArchiveV1 = z.infer<typeof archiveV1Schema>;
/** The archive a client reads or writes today. Only `v: 1` exists. */
export const archiveSchema = archiveV1Schema;
export type Archive = ArchiveV1;

export class ArchiveDecodeError extends Error {
  override readonly name = "ArchiveDecodeError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/**
 * UTF-8 JSON. Validated first so a malformed archive fails at the producer
 * and is never encrypted; unknown keys are dropped.
 */
export function encodeArchive(archive: Archive): Uint8Array {
  const parsed = archiveSchema.safeParse(archive);
  if (!parsed.success) throw new ArchiveDecodeError("not a valid Archive", { cause: parsed.error });
  return new TextEncoder().encode(JSON.stringify(parsed.data));
}

/** The inverse of {@link encodeArchive}. Throws {@link ArchiveDecodeError} on anything else. */
export function decodeArchive(bytes: Uint8Array): Archive {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new ArchiveDecodeError("Archive is not UTF-8 JSON", { cause });
  }
  const parsed = archiveSchema.safeParse(json);
  if (!parsed.success) throw new ArchiveDecodeError("not a valid Archive", { cause: parsed.error });
  return parsed.data;
}

// ---------------------------------------------------------------------------
// The manifest: what the server stores about an archive, signed by its producer.
// ---------------------------------------------------------------------------

export const ARCHIVE_KINDS = ["transfer", "backup"] as const;
export const archiveKindSchema = z.enum(ARCHIVE_KINDS);
export type ArchiveKind = z.infer<typeof archiveKindSchema>;

export const archiveManifestSchema = z.object({
  v: z.literal(ARCHIVE_VERSION),
  kind: archiveKindSchema,
  createdAt: isoDateSchema,
  conversationCount: nonNegativeIntSchema,
  eventCount: nonNegativeIntSchema,
  /** The chunk blobs, in order. Every one must exist and belong to the producer's account. */
  chunkBlobIds: z.array(blobIdSchema).min(1).max(ARCHIVE_MAX_CHUNKS),
  /** SHA-256 of the whole `encodeArchive` output, checked after decryption. */
  plaintextSha256: sha256HexSchema,
});
export type ArchiveManifest = z.infer<typeof archiveManifestSchema>;

/** Domain separator of the manifest signature. */
export const ARCHIVE_MANIFEST_SIGNING_CONTEXT = "allo-archive-manifest-v1";

/**
 * Canonical JSON: object keys sorted (recursively, by UTF-16 code unit
 * order), no whitespace, `undefined` members omitted, arrays in place.
 * Two producers serialising the same value get the same bytes, which is
 * what a signature over JSON needs. Throws `TypeError` on a value JSON
 * cannot carry (a function, a symbol, a bigint, NaN or Infinity).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical JSON cannot carry a non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",") + "]";
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
    }
    default:
      throw new TypeError(`canonical JSON cannot carry a ${typeof value}`);
  }
}

/**
 * The bytes (as a UTF-8 string) the producing instance signs with its Ed25519
 * key and the server — and every consumer — verifies:
 *
 *     "allo-archive-manifest-v1\n" + canonicalJson(manifest)
 */
export function archiveManifestMessage(manifest: ArchiveManifest): string {
  return ARCHIVE_MANIFEST_SIGNING_CONTEXT + "\n" + canonicalJson(manifest);
}
