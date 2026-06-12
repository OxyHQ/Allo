import crypto from "crypto";
import { getBridgeSessionKey } from "./config";

/**
 * Session-at-rest encryption for stored Telegram credentials.
 *
 * A Telegram `StringSession` is a bearer credential: anyone holding it can act as
 * the user on Telegram. We therefore NEVER store it in plaintext. Each session is
 * encrypted with AES-256-GCM under a key derived from `BRIDGE_SESSION_KEY`:
 *  - a FRESH random 96-bit IV per write (GCM's nonce-reuse failure mode is
 *    catastrophic, so the IV is never reused across writes),
 *  - the 128-bit GCM auth tag is stored alongside the ciphertext and verified on
 *    decrypt (tamper-evident: a flipped bit fails `final()` with an auth error).
 *
 * The 32-byte AES key is `SHA-256(BRIDGE_SESSION_KEY)` so any >=32-char operator
 * secret maps to a valid key length deterministically. Node `crypto` only — no
 * third-party crypto.
 */

/** AES-256-GCM IV length in bytes (96-bit nonce, the GCM-recommended size). */
const IV_LENGTH_BYTES = 12;

/** AES-256-GCM auth tag length in bytes (128-bit). */
const AUTH_TAG_LENGTH_BYTES = 16;

const ALGORITHM = "aes-256-gcm";

/** Shape of an encrypted session as persisted (all fields base64). */
export interface EncryptedPayload {
  /** Base64 IV (random per write). */
  iv: string;
  /** Base64 GCM auth tag (verified on decrypt). */
  authTag: string;
  /** Base64 ciphertext. */
  ciphertext: string;
}

/** Derive the 32-byte AES key from the operator secret. Throws if unset/short. */
function deriveKey(): Buffer {
  const secret = getBridgeSessionKey();
  if (!secret) {
    throw new Error("BRIDGE_SESSION_KEY is not configured or too short");
  }
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

/**
 * Encrypt a plaintext session string. Returns the IV, auth tag, and ciphertext
 * (all base64) for storage. A new random IV is generated on every call.
 */
export function encryptSession(plaintext: string): EncryptedPayload {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

/**
 * Decrypt a previously-encrypted session. Throws if the payload is malformed or
 * the auth tag does not verify (tampering / wrong key) — callers treat a throw as
 * "session unusable" and surface a session error rather than acting on garbage.
 */
export function decryptSession(payload: EncryptedPayload): string {
  const key = deriveKey();
  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const ciphertext = Buffer.from(payload.ciphertext, "base64");
  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error("Encrypted session has an invalid IV length");
  }
  if (authTag.length !== AUTH_TAG_LENGTH_BYTES) {
    throw new Error("Encrypted session has an invalid auth tag length");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH_BYTES,
  });
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
