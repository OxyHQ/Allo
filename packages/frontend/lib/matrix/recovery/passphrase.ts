import { hkdfSha256 } from '@oxyhq/core';
import { base64urlnopad } from '@scure/base';
import { mnemonicToSeed, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

import { MatrixRecoveryPhraseInvalidError } from '@/lib/matrix/errors';

/**
 * The passphrase that opens Allo's Matrix key backup, derived from the user's
 * Oxy identity.
 *
 * Matrix's server-side secret storage (4S) is unlocked either by a 32-byte key
 * the user has to keep, or by a passphrase the key is derived from. Allo takes
 * the second door and derives the passphrase from the BIP-39 phrase that already
 * *is* the Oxy identity, so that a user who signs in with Oxy gets their message
 * history back without ever being shown a second secret to write down. See
 * `docs/matrix/client-strategy.md` §3.
 *
 * **No cryptography is invented here.** This is HKDF-SHA256 — the same function
 * Oxy already uses for its own encrypted backup — with a label of its own, and
 * everything after it is Matrix's: the SDKs run the result through PBKDF2 with a
 * salt the homeserver publishes, at parameters that are identical on both
 * platforms (§3.3).
 *
 * The security of the whole scheme is therefore exactly the security of the Oxy
 * seed: 128 bits behind a 12-word phrase, 256 behind a 24-word one. The 500 000
 * PBKDF2 iterations Matrix applies on top exist to protect passphrases people
 * chose themselves and buy nothing here — which is fine, because there is no
 * dictionary to attack when the input is 256 bits of HKDF output (§3.5).
 */

/**
 * HKDF `salt`. Versioned, so that changing the scheme is a new label rather than
 * a silent change of meaning: `-v2` would derive a different passphrase, and a
 * user's old backup would stay openable with the old one.
 */
export const MATRIX_RECOVERY_KDF_SALT = 'allo-matrix-v1';

/**
 * HKDF `info`. Its only job is to be different from every other label derived
 * from the same seed.
 *
 * Oxy derives its own backup material from this seed under
 * `oxy-backup-encryption-key` and `oxy-backup-lookup-id`. A separate label is
 * what makes those independent: leaking Allo's Matrix passphrase reveals nothing
 * about Oxy's backup key, and the reverse.
 */
export const MATRIX_RECOVERY_KDF_INFO = 'allo-matrix-4s-passphrase';

/** 256 bits, matching the 4S key the passphrase will be stretched into. */
export const MATRIX_RECOVERY_PASSPHRASE_BYTES = 32;

const utf8 = new TextEncoder();

/**
 * Derives the 4S passphrase from an Oxy recovery phrase.
 *
 * The result is 43 characters of base64url with no padding, which is ASCII by
 * construction. That is not cosmetic: the native binding hands the passphrase to
 * Rust's `passphrase.as_bytes()` and the web SDK to `TextEncoder.encode`, so
 * keeping it ASCII is what guarantees the two platforms feed PBKDF2 the same
 * bytes without depending on how either normalises Unicode (§3.4).
 *
 * The return value is a credential. It must never be logged, never be sent to
 * Allo's backend, and never be written anywhere but the memory of the call that
 * needs it. JavaScript gives no way to wipe a string afterwards — Rust's FFI
 * zeroes its copy, and the TypeScript side simply cannot — so the discipline
 * that is available is to hold it briefly and let it go.
 *
 * @throws {MatrixRecoveryPhraseInvalidError} if the phrase is not a valid BIP-39
 * mnemonic. Checked rather than assumed: a mistyped word derives a perfectly
 * well-formed passphrase that simply opens nothing, and "your history is gone"
 * is a far worse thing to report than "that phrase is not right".
 */
export async function deriveMatrixRecoveryPassphrase(
  oxyRecoveryPhrase: string,
): Promise<string> {
  // The same normalisation Oxy applies before its own derivations, so that both
  // sides of the identity agree on what the phrase is.
  const phrase = oxyRecoveryPhrase.trim().toLowerCase();
  if (!validateMnemonic(phrase, wordlist)) {
    throw new MatrixRecoveryPhraseInvalidError();
  }

  // The whole 64-byte seed, not the first 32 bytes Oxy slices off for its
  // signing key. A device compromise that leaks only that private key therefore
  // cannot reach the message history.
  const seed = await mnemonicToSeed(phrase);
  const derived = hkdfSha256(
    seed,
    utf8.encode(MATRIX_RECOVERY_KDF_SALT),
    utf8.encode(MATRIX_RECOVERY_KDF_INFO),
    MATRIX_RECOVERY_PASSPHRASE_BYTES,
  );
  return base64urlnopad.encode(derived);
}
