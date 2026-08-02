import { readOxyRecoveryPhrase } from '@/lib/matrix/recovery/oxyIdentity';

/**
 * Reading the Oxy phrase, and the distinction the rest of the feature rests on.
 *
 * `KeyManager.getRecoveryMnemonic()` has two ways of not returning a phrase and
 * they mean opposite things: `null` is "this device holds none", a thrown error
 * is "storage could not be read". Flattening the second into the first is the
 * bug that makes an app decide a returning user is a new one — here it would
 * mean silently skipping a recovery that a retry a second later would have
 * completed.
 */

describe('readOxyRecoveryPhrase', () => {
  it('returns the phrase when the keychain holds one', async () => {
    await expect(readOxyRecoveryPhrase(async () => 'zoo zoo zoo')).resolves.toEqual({
      kind: 'available',
      phrase: 'zoo zoo zoo',
    });
  });

  it('reports a successful read that found nothing as absent', async () => {
    // Web always lands here — Oxy keeps identities in the native keychain only —
    // as does a native install whose identity predates Oxy storing the phrase.
    await expect(readOxyRecoveryPhrase(async () => null)).resolves.toEqual({
      kind: 'absent',
    });
  });

  it('reports a storage failure as unavailable, not as absent', async () => {
    const lookup = await readOxyRecoveryPhrase(async () => {
      throw new Error('Failed to read recovery mnemonic from secure storage.');
    });

    expect(lookup).toEqual({
      kind: 'unavailable',
      reason: 'Failed to read recovery mnemonic from secure storage.',
    });
  });

  it('describes a thrown non-error rather than losing it', async () => {
    // Secure-storage modules reject with all sorts of things.
    await expect(
      readOxyRecoveryPhrase(async () => {
        throw 'keychain unavailable';
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'keychain unavailable' });
  });

  it('treats an empty slot as absent rather than as a phrase', async () => {
    // A slot that exists and holds nothing is not a phrase. Passing it on would
    // report the user's own recovery phrase as invalid.
    await expect(readOxyRecoveryPhrase(async () => '')).resolves.toEqual({ kind: 'absent' });
    await expect(readOxyRecoveryPhrase(async () => '   \n')).resolves.toEqual({
      kind: 'absent',
    });
  });

  it('does not swallow the phrase’s own whitespace once there is a phrase', async () => {
    // Normalisation belongs to the derivation, which lowercases and trims to
    // match Oxy. This function reports what it found.
    await expect(readOxyRecoveryPhrase(async () => '  zoo zoo  ')).resolves.toEqual({
      kind: 'available',
      phrase: '  zoo zoo  ',
    });
  });
});
