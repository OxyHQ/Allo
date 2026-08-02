import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { EPHEMERAL_LIFETIME_CHOICES } from '@/lib/matrix/ephemeral/policy';

/**
 * How long a message lasts, in words.
 *
 * Shared by the two places that say it — the setting that chooses one and the
 * banner above a conversation that has one — because they have to agree. A
 * banner reading "24 hours" over a setting reading "1 day" is two features as
 * far as the reader is concerned.
 *
 * **Whole sentences, not a number and a unit.** The three languages Allo ships
 * in inflect the noun with the number, so `{{count}} hours` is a template only
 * English survives; each duration is its own translatable string.
 */

export interface EphemeralLifetimeChoice {
  readonly lifetimeMs: number;
  readonly label: string;
}

export interface EphemeralLifetimes {
  /** What the setting offers, in the order it offers them. */
  readonly choices: readonly EphemeralLifetimeChoice[];
  /**
   * The words for one lifetime.
   *
   * Answers even for a duration this build does not offer: another client, or a
   * later Allo, may have written one, and a conversation that showed nothing
   * would look like an ordinary one.
   */
  labelFor(lifetimeMs: number): string;
}

export function useEphemeralLifetimes(): EphemeralLifetimes {
  const { t } = useTranslation();

  return useMemo(() => {
    const named: ReadonlyMap<number, string> = new Map([
      [3_600_000, t('1 hour')],
      [86_400_000, t('24 hours')],
      [604_800_000, t('7 days')],
    ]);
    const labelFor = (lifetimeMs: number): string =>
      named.get(lifetimeMs) ??
      // A duration nobody wrote a sentence for, said in the smallest unit that
      // does not lose anything. Not pretty, and not a lie about what it is.
      t('{{count}} minutes', { count: Math.round(lifetimeMs / 60_000) });

    return {
      choices: EPHEMERAL_LIFETIME_CHOICES.map((lifetimeMs) => ({
        lifetimeMs,
        label: labelFor(lifetimeMs),
      })),
      labelFor,
    };
  }, [t]);
}
