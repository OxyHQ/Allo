import { KeyManager } from '@oxyhq/core';

/**
 * Getting the Oxy recovery phrase off this device.
 *
 * The phrase is the input to {@link deriveMatrixRecoveryPassphrase}, and it is
 * the one part of the scheme Allo does not own: Oxy generates it, shows it to
 * the user once, and keeps a copy in the device keychain so Settings can show it
 * again. Allo reads that copy and never writes one.
 *
 * **Where this does not work, and it is not a bug in this file.**
 * `KeyManager.getRecoveryMnemonic()` answers `null` on web without consulting
 * any storage — Oxy keeps identities in the native keychain only — and it also
 * answers `null` on native for any identity created before Oxy started keeping
 * the phrase. In both cases the phrase exists (the user wrote it down when they
 * made the account) but this process cannot see it, so nothing can be derived
 * without asking. That is why the three outcomes below are three and not a
 * `string | null`: "there is no phrase here" and "the keychain is locked, ask
 * again in a moment" want opposite responses, and collapsing either into a
 * failure would either nag a user who can do nothing or silently skip a recovery
 * that would have worked on retry.
 */

/** What reading the phrase from the device found. */
export type OxyRecoveryPhraseLookup =
  /** The phrase. A credential: derive from it and drop it. */
  | { readonly kind: 'available'; readonly phrase: string }
  /**
   * The read succeeded and this device holds no phrase. Web always lands here,
   * as does a native install whose identity predates Oxy keeping the phrase.
   * Nothing to retry: recovery needs the user to type it.
   */
  | { readonly kind: 'absent' }
  /**
   * Storage could not be read at all — a locked keychain, a module that failed
   * to load. Distinct from `absent` precisely because it *is* worth retrying,
   * and because treating a locked keychain as "no identity" is how an app
   * decides a user is new when they are not.
   */
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * How the phrase is read. Injected so the outcomes above can be tested without
 * a keychain, and so nothing in a test can reach a real identity.
 */
export type OxyRecoveryPhraseReader = () => Promise<string | null>;

/** Oxy's own reader: the device keychain, native only. */
const deviceKeychainReader: OxyRecoveryPhraseReader = () =>
  KeyManager.getRecoveryMnemonic();

/**
 * Reads the Oxy recovery phrase, reporting what happened rather than what was
 * found.
 *
 * The phrase is returned, not logged and not cached: the caller derives the
 * Matrix passphrase from it and lets both go. An empty or whitespace-only string
 * is reported as `absent`, because a keychain slot that exists but holds nothing
 * is not a phrase and pushing it into a BIP-39 validator would report it as the
 * user's mistake.
 */
export async function readOxyRecoveryPhrase(
  read: OxyRecoveryPhraseReader = deviceKeychainReader,
): Promise<OxyRecoveryPhraseLookup> {
  let phrase: string | null;
  try {
    phrase = await read();
  } catch (error) {
    // Never the error object itself into a message that might reach a log with
    // the phrase inside it; only its description.
    return {
      kind: 'unavailable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (phrase === null || phrase.trim() === '') {
    return { kind: 'absent' };
  }
  return { kind: 'available', phrase };
}
