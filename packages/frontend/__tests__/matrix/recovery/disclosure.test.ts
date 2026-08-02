import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  RECOVERY_DISCLOSURE_BODY,
  RECOVERY_DISCLOSURE_TITLE,
} from '@/components/matrix/recoveryDisclosureCopy';

/**
 * That the trade this scheme makes is stated to the user, in every language, and
 * still says the part nobody enjoys writing.
 *
 * Deriving the key backup passphrase from the Oxy identity buys the whole
 * feature — history that opens itself on a new device — at a price: whoever
 * holds the Oxy phrase can read messages sent *before* they got it, which in the
 * ordinary Matrix design would be behind a second credential. The design asks
 * for that to be in the interface rather than in a comment
 * (`docs/matrix/client-strategy.md` §3.6), because a user who thinks Allo keeps
 * a secret of its own will guard the phrase less carefully than they should.
 *
 * These checks are what a rewrite has to get past. A locale that loses the
 * strings, or English that turns into "your data is protected", fails here.
 */

const FRONTEND = join(__dirname, '..', '..', '..');
const LOCALES = join(FRONTEND, 'locales');

function localeFiles(): string[] {
  return readdirSync(LOCALES).filter((name) => name.endsWith('.json'));
}

function readLocale(name: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(join(LOCALES, name), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${name} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

describe('the recovery disclosure', () => {
  const files = localeFiles();

  it('ships in more than one language', () => {
    expect(files.length).toBeGreaterThan(1);
  });

  it.each(files)('is translated in %s', (name) => {
    const locale = readLocale(name);

    for (const key of [RECOVERY_DISCLOSURE_TITLE, RECOVERY_DISCLOSURE_BODY]) {
      const translation = locale[key];
      expect(typeof translation).toBe('string');
      // Not the key echoed back with a couple of words changed: a real
      // translation of the body is a paragraph.
      expect(String(translation).length).toBeGreaterThan(key.length / 2);
    }
  });

  it('still says that holding the phrase means reading past messages', () => {
    // The euphemism-resistant part. Each of these is a fact the user needs, and
    // a rewrite that drops one has changed what the app promises.
    expect(RECOVERY_DISCLOSURE_BODY).toContain('anyone who has that phrase can read them');
    expect(RECOVERY_DISCLOSURE_BODY).toContain('before they got it');
    expect(RECOVERY_DISCLOSURE_TITLE).toContain('Oxy recovery phrase');
  });

  it('is rendered by the settings screen', () => {
    // The copy existing in a component nobody mounts would satisfy every check
    // above and tell no user anything.
    const screen = readFileSync(join(FRONTEND, 'app', '(chat)', 'settings', 'index.tsx'), 'utf8');

    expect(screen).toContain('<RecoveryDisclosure />');
    expect(screen).toContain('@/components/matrix/RecoveryDisclosure');
  });

  it('draws the copy from this module rather than repeating it', () => {
    // Otherwise the checks above are about a string the screen no longer shows.
    const component = readFileSync(
      join(FRONTEND, 'components', 'matrix', 'RecoveryDisclosure.tsx'),
      'utf8',
    );

    expect(component).toContain('t(RECOVERY_DISCLOSURE_TITLE)');
    expect(component).toContain('t(RECOVERY_DISCLOSURE_BODY)');
  });
});
