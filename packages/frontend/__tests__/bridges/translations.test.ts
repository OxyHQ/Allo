import { createInstance } from 'i18next';

import en from '@/locales/en.json';
import es from '@/locales/es.json';
import itIT from '@/locales/it.json';

/**
 * That every string this feature puts on screen exists in all three languages,
 * and that the one with a number in it counts properly.
 *
 * The screens all pass a `defaultValue`, so a missing key degrades to English
 * rather than to a raw dotted identifier — which is the right failure but also a
 * silent one. Without this test, a Spanish user would get an English sentence and
 * nobody would find out until somebody noticed.
 */

const LOCALES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['en', en as Record<string, unknown>],
  ['es', es as Record<string, unknown>],
  ['it', itIT as Record<string, unknown>],
];

/** Every key the bridge screens ask for, including the six account states. */
const REQUIRED_KEYS: readonly string[] = [
  'settings.sections.linkedAccounts',
  'settings.linkedAccounts.title',
  'settings.linkedAccounts.description',
  'bridges.intro',
  'bridges.section.linked',
  'bridges.section.available',
  'bridges.noNetworks',
  'bridges.networksUnavailable',
  'bridges.accountsUnavailable',
  'bridges.disclosure.title',
  'bridges.disclosure.body',
  'bridges.action.reconnect',
  'bridges.action.unlink',
  'bridges.unlink.title',
  'bridges.unlink.body',
  'bridges.unlink.confirm',
  'bridges.warning.banRisk.title',
  'bridges.warning.banRisk.body',
  'bridges.capability.secretChats',
  'bridges.link.chooseFlow',
  'bridges.link.start',
  'bridges.link.startAccepting',
  'bridges.link.submit',
  'bridges.link.unavailable',
  'bridges.link.waiting',
  'bridges.link.displayImage',
  'bridges.link.fieldInvalid',
  'bridges.link.phoneHint',
  'bridges.link.phoneHintExplainer',
  'bridges.link.done',
  'bridges.link.doneBody',
  'bridges.mark.bridged',
  'bridges.mark.endToEnd',
  'common.cancel',
  'common.done',
];

/**
 * The six states of §5.3, spelled out rather than derived.
 *
 * `linked-accounts.tsx` builds these keys as `bridges.state.${account.state}`,
 * which is the one place a state can arrive that nobody wrote a sentence for.
 * Listing them here means adding a seventh state backend-side fails a test rather
 * than shipping a row labelled with its own key.
 */
const STATE_KEYS: readonly string[] = [
  'bridges.state.linking',
  'bridges.state.connecting',
  'bridges.state.connected',
  'bridges.state.degraded',
  'bridges.state.action_required',
  'bridges.state.failed',
];

/** Every placeholder a string interpolates, sorted so two can be compared. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort();
}

for (const [name, bundle] of LOCALES) {
  describe(`the ${name} translations`, () => {
    it('has every string the bridge screens ask for', () => {
      const missing = [...REQUIRED_KEYS, ...STATE_KEYS].filter(
        (key) => typeof bundle[key] !== 'string' || (bundle[key] as string).length === 0,
      );

      expect(missing).toEqual([]);
    });

    it('keeps every interpolation placeholder English uses', () => {
      /**
       * A translation that drops `{{network}}` produces a sentence about no
       * network in particular — and the ban warning is the one place where "your
       * account" without a name is exactly the ambiguity that makes it
       * dismissible.
       */
      const english = en as Record<string, unknown>;
      const mismatched: string[] = [];

      for (const key of [...REQUIRED_KEYS, ...STATE_KEYS]) {
        const source = english[key];
        const translated = bundle[key];
        if (typeof source !== 'string' || typeof translated !== 'string') continue;
        if (placeholders(translated).join() !== placeholders(source).join()) {
          mismatched.push(key);
        }
      }

      expect(mismatched).toEqual([]);
    });

    it('pluralises the one string that counts', () => {
      /**
       * i18next 26 resolves `count` through `Intl.PluralRules` and looks for
       * `_one`/`_other`. A single unsuffixed key still renders, which is exactly
       * why this is worth asserting: the bug is not a crash and not a missing
       * string, it is the sentence "2 account already linked" going out in a
       * release.
       */
      const i18n = createInstance();
      void i18n.init({
        lng: name,
        resources: { [name]: { translation: bundle } },
        interpolation: { escapeValue: false },
      });

      const one = i18n.t('bridges.alreadyLinked', { count: 1 });
      const many = i18n.t('bridges.alreadyLinked', { count: 2 });

      expect(one).not.toContain('{{');
      expect(many).not.toContain('{{');
      expect(many).toContain('2');

      /**
       * The words, with the numbers taken out — and this is the assertion that
       * has teeth.
       *
       * Comparing `one` to `many` directly passes on a single unsuffixed key,
       * because the two strings already differ by the interpolated digit. Only
       * with the digits removed does "account already linked" have to differ from
       * "accounts already linked". Measured, not assumed: this test passed on the
       * broken single-key form until these two lines were added.
       */
      const withoutNumbers = (text: string): string => text.replace(/\d+/g, '').trim();
      expect(withoutNumbers(one)).not.toBe(withoutNumbers(many));
    });
  });
}
