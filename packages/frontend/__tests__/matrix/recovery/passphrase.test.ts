import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad } from '@scure/base';
import { mnemonicToSeed } from '@scure/bip39';

import { MatrixRecoveryPhraseInvalidError } from '@/lib/matrix/errors';
import {
  MATRIX_RECOVERY_KDF_INFO,
  MATRIX_RECOVERY_KDF_SALT,
  deriveMatrixRecoveryPassphrase,
} from '@/lib/matrix/recovery/passphrase';

/**
 * The derivation, which is the one thing here that can never change by accident.
 *
 * The passphrase is not a value anyone stores: it is recomputed from the Oxy
 * phrase every time a device needs to open the key backup. So a change to the
 * salt, the label, the seed, the length or the encoding does not fail — it
 * derives a *different, perfectly valid* passphrase, the homeserver refuses it,
 * and every user already on the old scheme is told their history cannot be
 * opened. There is no loud failure available at runtime. These tests are it.
 *
 * Which is why the expected value below is a literal. A test that recomputed the
 * answer the way the code does would agree with every mutation of the code.
 *
 * The second test recomputes it anyway, from the primitives and through a
 * *different* copy of HKDF than the one the code uses: the frontend resolves
 * `@noble/hashes` at version 2, and `hkdfSha256` inside `@oxyhq/core` resolves
 * its own version 1. Two independent implementations agreeing on RFC 5869 is
 * worth more than one agreeing with itself.
 */

/** The BIP-39 test vector, so the input is one anybody can reproduce. */
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/**
 * The passphrase this scheme derives from {@link PHRASE}. Pinned.
 *
 * If a change to `passphrase.ts` makes this fail, that is the test doing its
 * job: every backup created under the old value can only be opened by the old
 * value, so changing the scheme means a new `-v2` label and a migration for the
 * accounts already on `-v1`, not a new expectation here.
 */
const EXPECTED = '8yo397uhecwizLTrXZZ9AKZ5YWgJYYD-prr70hXxlQc';

const utf8 = new TextEncoder();

describe('deriveMatrixRecoveryPassphrase', () => {
  it('derives the pinned passphrase for the BIP-39 test vector', async () => {
    await expect(deriveMatrixRecoveryPassphrase(PHRASE)).resolves.toBe(EXPECTED);
  });

  it('is HKDF-SHA256 over the whole 64-byte seed under Allo’s own labels', async () => {
    const seed = await mnemonicToSeed(PHRASE);
    // The whole seed, not the 32 bytes Oxy slices off for its signing key.
    expect(seed.length).toBe(64);

    const expected = hkdf(
      sha256,
      seed,
      utf8.encode('allo-matrix-v1'),
      utf8.encode('allo-matrix-4s-passphrase'),
      32,
    );

    const passphrase = await deriveMatrixRecoveryPassphrase(PHRASE);
    expect(base64urlnopad.decode(passphrase)).toEqual(expected);
  });

  it('is independent of the labels Oxy derives its own backup key with', async () => {
    // Domain separation is what bounds the blast radius: leaking the Matrix
    // passphrase must reveal nothing about Oxy's backup key. Same seed, same
    // KDF, different labels — so the outputs must not agree.
    const seed = await mnemonicToSeed(PHRASE);
    const oxyBackupKey = hkdf(
      sha256,
      seed,
      utf8.encode('oxy-identity-backup-v1'),
      utf8.encode('oxy-backup-encryption-key'),
      32,
    );

    const passphrase = await deriveMatrixRecoveryPassphrase(PHRASE);
    expect(base64urlnopad.decode(passphrase)).not.toEqual(oxyBackupKey);
  });

  it('does not fall back to the first 32 seed bytes that are Oxy’s signing key', async () => {
    // If the derivation ever collapsed to that, a device compromise that leaked
    // only the signing key would hand over every message ever sent as well.
    const seed = await mnemonicToSeed(PHRASE);
    const passphrase = await deriveMatrixRecoveryPassphrase(PHRASE);
    expect(base64urlnopad.decode(passphrase)).not.toEqual(seed.subarray(0, 32));
  });

  it('produces 43 characters of ASCII base64url with no padding', async () => {
    const passphrase = await deriveMatrixRecoveryPassphrase(PHRASE);
    // 32 bytes, unpadded. The alphabet matters as much as the length: both SDKs
    // feed this string to PBKDF2 as UTF-8, and staying inside ASCII is what
    // makes Rust's `as_bytes()` and JavaScript's `TextEncoder` produce the same
    // input without depending on Unicode normalisation.
    expect(passphrase).toHaveLength(43);
    expect(passphrase).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('normalises case and surrounding whitespace, as Oxy does', async () => {
    // A phrase pasted with a trailing newline has to reach the same key, or the
    // same user gets two backups depending on how they typed it.
    await expect(deriveMatrixRecoveryPassphrase(`  ${PHRASE.toUpperCase()}\n`)).resolves.toBe(
      EXPECTED,
    );
  });

  it('derives a different passphrase for a different phrase', async () => {
    const other =
      'legal winner thank year wave sausage worth useful legal winner thank yellow';
    await expect(deriveMatrixRecoveryPassphrase(other)).resolves.not.toBe(EXPECTED);
  });

  it('refuses a phrase whose checksum does not hold', async () => {
    // Twelve real BIP-39 words with a bad checksum: the shape a mistyped last
    // word takes. Deriving from it would produce a valid-looking passphrase that
    // opens nothing, and the user would be told their history was lost.
    const mistyped =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon';
    await expect(deriveMatrixRecoveryPassphrase(mistyped)).rejects.toBeInstanceOf(
      MatrixRecoveryPhraseInvalidError,
    );
  });

  it('refuses a phrase containing a word outside the wordlist', async () => {
    const notWords = 'this is not a bip39 phrase at all it is just english';
    await expect(deriveMatrixRecoveryPassphrase(notWords)).rejects.toBeInstanceOf(
      MatrixRecoveryPhraseInvalidError,
    );
  });

  it('refuses an empty phrase rather than deriving from nothing', async () => {
    await expect(deriveMatrixRecoveryPassphrase('')).rejects.toBeInstanceOf(
      MatrixRecoveryPhraseInvalidError,
    );
  });

  it('says nothing about the phrase in the error it raises', async () => {
    // The phrase is the whole Oxy identity, and an error message is the easiest
    // way for one to reach a log or a crash report.
    const secret = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo';
    expect.assertions(1);
    try {
      await deriveMatrixRecoveryPassphrase(secret);
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain('zoo');
    }
  });

  it('keeps its labels versioned and distinct from Oxy’s', () => {
    // Exported so that a future scheme change is visibly a new label rather than
    // an edit to an old one.
    expect(MATRIX_RECOVERY_KDF_SALT).toBe('allo-matrix-v1');
    expect(MATRIX_RECOVERY_KDF_INFO).toBe('allo-matrix-4s-passphrase');
  });
});
