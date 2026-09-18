/**
 * The recovery phrase, as the screens handle it.
 *
 * The SDK owns the phrase: `client.backup.enable()` mints it and
 * `client.backup.restore()` checks it, both of them normalising what they are
 * given. What a screen needs on top is small — the same normalisation, so the
 * word count it shows under the input is the count the SDK will see, and the
 * number of words a phrase has — and it is re-exported from here because
 * `@allo/core` is imported for values only inside `lib/allo/`.
 *
 * The phrase itself is never written anywhere by the app: not to a store, not
 * to a log, not to a preference. It lives in a screen's state while it is on
 * screen and nowhere once it is not.
 */
export { normalizeRecoveryPhrase, RECOVERY_PHRASE_WORDS } from '@allo/core';

/** How many words the person has typed so far, counted the way the SDK counts them. */
export function recoveryPhraseWordCount(input: string): number {
  const trimmed = input.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}
