/**
 * The words of the recovery disclosure, in one place.
 *
 * Separate from the component that draws them for two reasons. The copy is the
 * requirement — `docs/matrix/client-strategy.md` §3.6 asks for this to be said
 * to the user in plain words, not recorded in a comment — so it is worth being
 * able to check that every locale still carries it and that it still says the
 * uncomfortable part. And a `.ts` module can be checked without a renderer,
 * which a `.tsx` one cannot.
 *
 * These strings are also the i18next keys, which is how the rest of the app
 * works: the English sentence is the key, and `locales/*.json` map it.
 */

export const RECOVERY_DISCLOSURE_TITLE =
  'Your Oxy recovery phrase opens your Allo history';

export const RECOVERY_DISCLOSURE_BODY =
  'Allo unlocks your encrypted message backup with a key derived from your Oxy ' +
  'recovery phrase. That is why a new device can read your old conversations as ' +
  'soon as you sign in — and it means anyone who has that phrase can read them ' +
  'too, including messages sent before they got it. Keep it as carefully as you ' +
  'would keep the conversations themselves.';
