import { createInstance } from 'i18next';

import en from '@/locales/en.json';
import es from '@/locales/es.json';
import itIT from '@/locales/it.json';

/**
 * That the words for somebody who cannot be named exist in all three languages.
 *
 * The whole point of the change these belong to is that a person is never drawn
 * as an identifier. A missing key renders as its own dotted name, so
 * `chat.person.unknown` going untranslated would put `chat.person.unknown` in a
 * member row — which is the same failure in a different alphabet, and invisible
 * to whoever ships it because English is the language that has the key.
 */

const LOCALES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['en', en as Record<string, unknown>],
  ['es', es as Record<string, unknown>],
  ['it', itIT as Record<string, unknown>],
];

/** What a person who could not be resolved reads as. */
const UNKNOWN_PERSON_KEY = 'chat.person.unknown';

/**
 * The refusal, in both of its forms.
 *
 * The second one exists because the first cannot be written honestly when one of
 * the people in it has no name: "the identity of Bruno, Unknown person" reads as
 * a bug. See `components/matrix/ephemeralRefusal.ts`.
 */
const REFUSAL_NAMING_PEOPLE =
  'Allo will not send here: it does not recognise the identity of {{people}}. Ask them to open Allo and finish setting up their account.';
const REFUSAL_NAMING_NOBODY =
  'Allo will not send here: it does not recognise the identity of everybody in this conversation. Ask them to open Allo and finish setting up their account.';

const REQUIRED_KEYS: readonly string[] = [
  UNKNOWN_PERSON_KEY,
  REFUSAL_NAMING_PEOPLE,
  REFUSAL_NAMING_NOBODY,
];

for (const [name, bundle] of LOCALES) {
  describe(`the ${name} translations`, () => {
    it('names somebody who could not be looked up', () => {
      const missing = REQUIRED_KEYS.filter(
        (key) => typeof bundle[key] !== 'string' || (bundle[key] as string).length === 0,
      );

      expect(missing).toEqual([]);
    });

    it('resolves the flat dotted key rather than reading it as a path', () => {
      // The bundles are flat: `chat.person.unknown` is one entry at the top
      // level and not a `chat` object. i18next finds a flat key before it splits
      // on the separator, and this is what says so out loud.
      const i18n = createInstance();
      void i18n.init({
        lng: name,
        resources: { [name]: { translation: bundle } },
        interpolation: { escapeValue: false },
      });

      const unknown = i18n.t(UNKNOWN_PERSON_KEY);
      expect(unknown).not.toBe(UNKNOWN_PERSON_KEY);
      expect(unknown).not.toContain('.');

      const refusal = i18n.t(REFUSAL_NAMING_PEOPLE, { people: 'Alba' });
      expect(refusal).not.toContain('{{');
      expect(refusal).toContain('Alba');
    });
  });
}
