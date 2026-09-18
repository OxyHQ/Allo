/**
 * The backup key and the recovery phrase it comes from.
 *
 *   phrase (12 English BIP39 words) → 128-bit entropy
 *     → HKDF-SHA256(ikm = entropy, salt = "allo-backup-v1", info = accountId)
 *     → 32-byte AES-256 key
 *
 * The `info` binds the key to one account so the same phrase on another
 * account derives another key. `keyCheck` is HMAC-SHA256 of a fixed string
 * under the key, stored next to the backup, so a mistyped phrase is refused
 * before a single chunk is downloaded. The phrase is never persisted and
 * never logged; only the derived key is kept, in the host's `SecretStore`.
 */
import { entropyToMnemonic, generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { expand as hkdfExpand, extract as hkdfExtract } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { BACKUP_KDF_SALT, BACKUP_KEY_CHECK_MESSAGE } from "@allo/shared-types";
import { RecoveryPhraseError } from "../errors";
import { base64Decode, base64Encode, bytesEqual, utf8Encode } from "../util/bytes";

export const BACKUP_KEY_BYTES = 32;
export const RECOVERY_PHRASE_WORDS = 12;
const ENTROPY_BITS = 128;

export function backupKeyName(accountId: string, appId: string): string {
  return `allo.backup-key.${accountId}.${appId}`;
}

/** A fresh 12-word phrase. Show it once; it is the only way back into a backup. */
export function generateRecoveryPhrase(): string {
  return generateMnemonic(wordlist, ENTROPY_BITS);
}

/** Lower-cases and collapses whitespace so what the user typed compares as the words alone. */
export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase.trim().toLowerCase().split(/\s+/).join(" ");
}

export function validateRecoveryPhrase(phrase: string): boolean {
  const normalized = normalizeRecoveryPhrase(phrase);
  if (normalized.split(" ").length !== RECOVERY_PHRASE_WORDS) return false;
  return validateMnemonic(normalized, wordlist);
}

/** The entropy behind a phrase, as its canonical 12 words. Throws {@link RecoveryPhraseError}. */
export function canonicalRecoveryPhrase(phrase: string): string {
  return entropyToMnemonic(phraseEntropy(phrase), wordlist);
}

function phraseEntropy(phrase: string): Uint8Array {
  const normalized = normalizeRecoveryPhrase(phrase);
  if (!validateRecoveryPhrase(normalized)) throw new RecoveryPhraseError("not a valid 12-word recovery phrase");
  return mnemonicToEntropy(normalized, wordlist);
}

/** Derives the account's 32-byte backup key from a phrase. Throws {@link RecoveryPhraseError} on a malformed phrase. */
export function deriveBackupKey(phrase: string, accountId: string): Uint8Array {
  const entropy = phraseEntropy(phrase);
  const prk = hkdfExtract(sha256, entropy, utf8Encode(BACKUP_KDF_SALT));
  return hkdfExpand(sha256, prk, utf8Encode(accountId), BACKUP_KEY_BYTES);
}

/** base64 HMAC-SHA256 of {@link BACKUP_KEY_CHECK_MESSAGE} under the key. */
export function backupKeyCheck(key: Uint8Array): string {
  return base64Encode(backupKeyCheckBytes(key));
}

function backupKeyCheckBytes(key: Uint8Array): Uint8Array {
  return hmac(sha256, key, utf8Encode(BACKUP_KEY_CHECK_MESSAGE));
}

/** Constant-time comparison of a stored `keyCheck` with the one a key produces. */
export function backupKeyMatches(key: Uint8Array, keyCheckB64: string): boolean {
  let stored: Uint8Array;
  try {
    stored = base64Decode(keyCheckB64);
  } catch {
    return false;
  }
  return bytesEqual(backupKeyCheckBytes(key), stored);
}
