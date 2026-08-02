import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

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
 * Answers `undefined` for anything else, so the caller keeps its existing
 * handling for everything that really is an error.
 */
export function useEphemeralRefusalMessage(): (error: unknown) => string | undefined {
  const { t } = useTranslation();

  return useCallback(
    (error: unknown): string | undefined => {
      if (!(error instanceof MatrixEphemeralUntrustedError)) {
        return undefined;
      }
      if (error.refusal.kind === 'own-device-unverified') {
        return t(
          'Allo will not send here until this device is verified with your Oxy recovery phrase, in Settings.',
        );
      }
      return t(
        'Allo will not send here: it does not recognise the identity of {{people}}. Ask them to open Allo and finish setting up their account.',
        { people: error.refusal.userIds.join(', ') },
      );
    },
    [t],
  );
}
