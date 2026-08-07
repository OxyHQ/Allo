import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import type { ChatPeopleLookup } from '@/lib/chat/people';
import { MatrixEphemeralUntrustedError } from '@/lib/matrix/errors';

/**
 * The one port refusal a user is meant to read, in their own language.
 *
 * Every other failure the chat port raises is something gone wrong, and the
 * composer shows its message as it comes. This one is not a failure: it is the
 * ephemeral tier's rule being applied, it will happen again on the next attempt,
 * and it names a person the reader knows. An English sentence about
 * cross-signing identities would be the app refusing to explain itself at the
 * one moment it has to.
 *
 * **It names people and not identifiers.** `AlloEphemeralRefusal.userIds` holds
 * Matrix user ids, and joining them into the sentence made the toast read "it
 * does not recognise the identity of @<hex>:allo.you" — a refusal the reader
 * cannot act on, because they have no idea who that is. `EphemeralSection` has
 * taken a `nameOf` mapper for exactly this reason since it was written; this
 * does the same with `lib/chat/people.ts`.
 *
 * The wording lives in {@link ephemeralRefusalMessage}, which is a plain
 * function, so that what it says can be checked without a renderer — the same
 * reason `recoveryDisclosureCopy.ts` is a `.ts` module beside its component.
 */

/** Just enough of i18next's `t` to write a sentence, so a test can supply one. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The key for somebody `lib/chat/people.ts` could not name. */
export const UNKNOWN_PERSON_KEY = 'chat.person.unknown';

export const REFUSAL_OWN_DEVICE_KEY =
  'Allo will not send here until this device is verified with your Oxy recovery phrase, in Settings.';

export const REFUSAL_NAMING_PEOPLE_KEY =
  'Allo will not send here: it does not recognise the identity of {{people}}. Ask them to open Allo and finish setting up their account.';

/**
 * The same refusal for a conversation where at least one of the people cannot
 * be named.
 *
 * It exists because the sentence above cannot be written honestly then: "the
 * identity of Bruno, Unknown person" reads as a bug, and padding the list with
 * the honest word for one of its entries is worse than not listing it. So the
 * list is dropped whole and the sentence says the same thing without pretending
 * to enumerate.
 */
export const REFUSAL_NAMING_NOBODY_KEY =
  'Allo will not send here: it does not recognise the identity of everybody in this conversation. Ask them to open Allo and finish setting up their account.';

/**
 * What to say about a failed send, or `undefined` for anything that is not this
 * refusal — so the caller keeps its existing handling for everything that
 * really is an error.
 */
export function ephemeralRefusalMessage(
  error: unknown,
  people: ChatPeopleLookup,
  t: Translate,
): string | undefined {
  if (!(error instanceof MatrixEphemeralUntrustedError)) {
    return undefined;
  }
  if (error.refusal.kind === 'own-device-unverified') {
    return t(REFUSAL_OWN_DEVICE_KEY);
  }

  const named: string[] = [];
  for (const userId of error.refusal.userIds) {
    const name = people(userId)?.displayName;
    if (name === undefined || name === '') {
      named.length = 0;
      break;
    }
    named.push(name);
  }
  if (named.length === 0) {
    return t(REFUSAL_NAMING_NOBODY_KEY);
  }
  return t(REFUSAL_NAMING_PEOPLE_KEY, { people: named.join(', ') });
}

/**
 * @param people who the participants are. A lookup that knows nobody is allowed
 * and is what the Express backend passes: the refusal cannot be raised there,
 * and every name falls back to the honest sentence rather than to an id.
 */
export function useEphemeralRefusalMessage(
  people: ChatPeopleLookup,
): (error: unknown) => string | undefined {
  const { t } = useTranslation();

  return useCallback(
    (error: unknown): string | undefined => ephemeralRefusalMessage(error, people, t),
    [people, t],
  );
}
