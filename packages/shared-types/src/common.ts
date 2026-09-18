/**
 * Primitives every v1 contract is built from.
 *
 * Everything on the wire is JSON; bytes travel as base64 (standard alphabet,
 * padded) except where a URL or a header carries them, which is base64url
 * (no padding). Ids are OPAQUE TEXT: rows written since the Postgres cutover
 * carry a uuid v7, rows the backfill copied carry a 24-hex Mongo ObjectId, and
 * Oxy account ids are ObjectIds too. Nothing may assume a format, so
 * {@link idSchema} accepts the alphabet both shapes share and nothing narrower.
 */
import { z } from "zod";

/** Standard base64, padded, non-empty. `max` bounds the ENCODED length. */
export const base64Schema = (max?: number) => {
  const s = z.base64().min(1);
  return max === undefined ? s : s.max(max);
};

/** base64url (RFC 4648 §5), unpadded, non-empty. `max` bounds the encoded length. */
export const base64UrlSchema = (max?: number) => {
  const s = z.base64url().min(1);
  return max === undefined ? s : s.max(max);
};

/**
 * An opaque text id. Covers a uuid v7 (36 chars, hyphens), a 24-character hex
 * ObjectId and a 32-byte-hex blob id (64 chars) — one alphabet, one length
 * band, no format assumption.
 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
export const idSchema = z.string().regex(ID_PATTERN, "expected an opaque text id");
export type Id = z.infer<typeof idSchema>;

export const accountIdSchema = idSchema;
export const instanceIdSchema = idSchema;
export const conversationIdSchema = idSchema;
export const eventIdSchema = idSchema;
export const blobIdSchema = idSchema;

/** The product an instance belongs to: `allo`, `mention`, … */
export const APP_ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
export const appIdSchema = z.string().regex(APP_ID_PATTERN, "expected an app id");
export type AppId = z.infer<typeof appIdSchema>;

export const PLATFORMS = ["ios", "android", "web", "desktop", "node"] as const;
export const platformSchema = z.enum(PLATFORMS);
export type Platform = z.infer<typeof platformSchema>;

/** An ISO-8601 timestamp as `Date#toISOString()` emits it; an offset is tolerated. */
export const isoDateSchema = z.iso.datetime({ offset: true });
export type IsoDate = z.infer<typeof isoDateSchema>;

/** Lowercase hex SHA-256 digest. */
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
export const sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN, "expected lowercase hex sha-256");

/** SHA-256 of the empty string — the body digest of a request with no body. */
export const EMPTY_BODY_SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/** A raw 32-byte Ed25519 public key, base64: exactly 44 characters. */
export const ed25519PublicKeySchema = z.base64().length(44);
/** A 64-byte Ed25519 signature, base64: exactly 88 characters. */
export const ed25519SignatureSchema = z.base64().length(88);
/** A raw 32-byte X25519 public key, base64: exactly 44 characters (the instance transfer key). */
export const x25519PublicKeySchema = z.base64().length(44);

/** A non-negative integer that fits a JSON number exactly (epochs, seqs, sizes). */
export const nonNegativeIntSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Client-chosen idempotency key. */
export const idempotencyKeySchema = z.string().min(1).max(128);

export const ALLO_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "epoch_conflict",
  "group_info_missing",
  "instance_not_active",
  "instance_revoked",
  "key_packages_exhausted",
  "idempotency_conflict",
  "payload_too_large",
  "transfer_key_missing",
  "backup_not_found",
  "rate_limited",
  "unavailable",
  "internal",
] as const;
export const alloErrorCodeSchema = z.enum(ALLO_ERROR_CODES);
export type AlloErrorCode = z.infer<typeof alloErrorCodeSchema>;

/**
 * Every non-2xx answer. `code` is typed as a string rather than the closed set
 * so a client parsing the answer of a NEWER server does not fail on a code it
 * has not heard of; {@link alloErrorCodeSchema} is what a server may emit.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** `details` of an `epoch_conflict` answer: the epoch the server is at. */
export const epochConflictDetailsSchema = z.object({
  currentEpoch: nonNegativeIntSchema,
});
export type EpochConflictDetails = z.infer<typeof epochConflictDetailsSchema>;

// ---------------------------------------------------------------------------
// base64url codec. Pure JS on purpose: this package runs in Node, browsers and
// Hermes, and `Buffer` / `atob` are not on every one of them.
// ---------------------------------------------------------------------------

const B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64URL_LOOKUP: Record<string, number> = Object.fromEntries(
  Array.from(B64URL_ALPHABET, (c, i) => [c, i] as const),
);

/** Encode bytes as unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      B64URL_ALPHABET[(n >> 18) & 63] +
      B64URL_ALPHABET[(n >> 12) & 63] +
      B64URL_ALPHABET[(n >> 6) & 63] +
      B64URL_ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += B64URL_ALPHABET[(n >> 18) & 63] + B64URL_ALPHABET[(n >> 12) & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      B64URL_ALPHABET[(n >> 18) & 63] +
      B64URL_ALPHABET[(n >> 12) & 63] +
      B64URL_ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/** Decode unpadded base64url. Throws `RangeError` on any character or length that is not base64url. */
export function base64UrlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new RangeError("malformed base64url: impossible length");
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const c of text) {
    const v = B64URL_LOOKUP[c];
    if (v === undefined) throw new RangeError("malformed base64url: bad character");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[o++] = (acc >> bits) & 0xff;
    }
  }
  return bytes;
}
