import type { AlloChatClient } from '@/lib/matrix/types';

import { readOxyRecoveryPhrase, type OxyRecoveryPhraseReader } from './oxyIdentity';
import { deriveMatrixRecoveryPassphrase } from './passphrase';

/**
 * The one decision the recovery scheme makes, and where it is made.
 *
 * Every branch below comes from `docs/matrix/client-strategy.md` §3.4: what to
 * do depends only on {@link AlloRecoveryState}, and each of the three actionable
 * states has exactly one right answer. Two of the wrong answers are expensive
 * enough to be worth naming:
 *
 * - calling `enableRecovery` in state `enabled` or `incomplete` builds a second
 *   4S store and makes it the default. The first one, with the keys that decrypt
 *   the user's history, is still on the server and nothing opens it any more.
 * - skipping recovery in state `incomplete` leaves a device that can read
 *   nothing sent before it existed, and that stays unverified — which is the
 *   state a new phone is in the moment it finishes signing in.
 *
 * The logic lives here, apart from both SDKs, so it can be tested without either
 * one: the client is a three-method interface a fake satisfies in a dozen lines.
 * That is deliberate. A green suite that only proved the SDKs get called would
 * not protect what this protects.
 */

/**
 * The three methods of the port this decision needs. Nothing else.
 *
 * Taken from {@link AlloChatClient} rather than restated, so a change to any of
 * the three signatures is a compile error here instead of a fake that still
 * satisfies an interface the real client no longer matches.
 */
export type RecoveryCapableClient = Pick<
  AlloChatClient,
  'recoveryState' | 'enableRecovery' | 'recoverWithPassphrase'
>;

/** Why recovery was not attempted. Each of these is a different thing to say. */
export type AlloRecoverySkipReason =
  /**
   * This device holds no copy of the Oxy phrase, so nothing can be derived
   * without asking the user for it. Always the case on web, and the case on
   * native for identities created before Oxy kept the phrase. Permanent until
   * the user types the phrase in — retrying changes nothing.
   */
  | 'no-phrase-on-this-device'
  /**
   * The keychain could not be read. Temporary by nature — a locked device, a
   * storage module still coming up — so the right response is to try again, not
   * to tell the user anything.
   */
  | 'phrase-unreadable'
  /**
   * The crypto stack has not finished starting, so the state is `unknown` and
   * every action would be a guess. Also temporary.
   */
  | 'state-not-settled';

/** What {@link ensureMatrixRecovery} did. */
export type AlloRecoveryOutcome =
  /** There was no 4S; this device created it from the Oxy-derived passphrase. */
  | { readonly kind: 'created' }
  /**
   * 4S existed and this device took what it was missing from it. Messages older
   * than this device are readable now, and it is cross-signing verified.
   */
  | { readonly kind: 'recovered' }
  /** Nothing to do: this device already had everything. */
  | { readonly kind: 'already-enabled' }
  /** Nothing was attempted. {@link AlloRecoverySkipReason} says why. */
  | { readonly kind: 'skipped'; readonly reason: AlloRecoverySkipReason };

/**
 * Seams for tests. The defaults are the real thing, so app code passes nothing.
 */
export interface EnsureMatrixRecoveryOptions {
  readonly readPhrase?: OxyRecoveryPhraseReader;
  readonly derivePassphrase?: (phrase: string) => Promise<string>;
}

/**
 * Brings this device's key backup to where it should be, deriving the passphrase
 * from the Oxy identity and asking the user for nothing.
 *
 * Safe to call whenever a session becomes usable — after a fresh sign-in and
 * after restoring a stored one — because `already-enabled` is the ordinary
 * answer and it costs one call.
 *
 * Failures of the two actions are **not** caught. A recovery that fails is not
 * the same as one that was not needed, and the caller has to be able to tell a
 * user that their history did not come back.
 */
export async function ensureMatrixRecovery(
  client: RecoveryCapableClient,
  options: EnsureMatrixRecoveryOptions = {},
): Promise<AlloRecoveryOutcome> {
  const state = await client.recoveryState();

  // Read before the phrase is fetched, so the ordinary launch of an already
  // recovered device never touches the keychain: no biometric prompt the user
  // did not ask for, and no credential in memory with nothing to do.
  if (state === 'enabled') {
    return { kind: 'already-enabled' };
  }
  if (state === 'unknown') {
    return { kind: 'skipped', reason: 'state-not-settled' };
  }

  const lookup = await readOxyRecoveryPhrase(options.readPhrase);
  if (lookup.kind === 'absent') {
    return { kind: 'skipped', reason: 'no-phrase-on-this-device' };
  }
  if (lookup.kind === 'unavailable') {
    return { kind: 'skipped', reason: 'phrase-unreadable' };
  }

  const derive = options.derivePassphrase ?? deriveMatrixRecoveryPassphrase;
  const passphrase = await derive(lookup.phrase);

  if (state === 'disabled') {
    await client.enableRecovery(passphrase);
    return { kind: 'created' };
  }
  await client.recoverWithPassphrase(passphrase);
  return { kind: 'recovered' };
}
