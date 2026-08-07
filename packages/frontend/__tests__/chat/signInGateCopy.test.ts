import { readFileSync } from 'fs';
import { join } from 'path';

import en from '@/locales/en.json';
import es from '@/locales/es.json';
import itIT from '@/locales/it.json';

/**
 * WHAT THE GATE IS ALLOWED TO CLAIM.
 *
 * Whoever reads this screen is signed in. The Oxy session is live, their own
 * avatar is drawn in the sidebar, and every Oxy-backed thing in the app already
 * knows who they are. The only thing missing is a Matrix access token.
 *
 * The screen used to say "Allo could not sign you in", which says the opposite,
 * and next to their own face it read as a second account they were being asked
 * to keep. There is no second account: the Matrix identity is derived from the
 * Oxy one through MAS. The owner reported exactly that confusion — "es como que
 * hay dos sign in ... si te fijas hasta se ve mi avatar".
 *
 * So the wording is a behaviour, not decoration, and it is asserted like one.
 * The removed keys are asserted GONE rather than merely unused: a bundle that
 * still carries "Allo could not sign you in" is one `t()` call away from saying
 * it again, and the string reads as deliberate to the next person who finds it.
 */

const LOCALES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['en', en as Record<string, unknown>],
  ['es', es as Record<string, unknown>],
  ['it', itIT as Record<string, unknown>],
];

/** Every string the gate can put on screen. */
const REQUIRED_KEYS: readonly string[] = [
  'Connecting…',
  'Finish signing in',
  'Allo is waiting for the sign-in page in your browser.',
  'Taking you to sign in…',
  'Finishing your sign-in…',
  'Connect your chat',
  'Allo will take you to Oxy for a moment and bring you straight back.',
  'Allo could not connect your chat',
  'Something went wrong. Try again.',
  'Try again',
  'Continue',
];

/**
 * Wording the gate may not carry, in any language.
 *
 * Each one tells a signed-in person that they are not, or frames the Matrix
 * token as an account of its own.
 */
const FORBIDDEN_KEYS: readonly string[] = [
  'Allo could not sign you in',
  'Sign in to start chatting',
  'One more step and your conversations are here.',
];

const GATE = join(__dirname, '..', '..', 'components', 'matrix', 'MatrixSignInGate.tsx');

describe('the sign-in gate does not tell a signed-in person to sign in', () => {
  const source = readFileSync(GATE, 'utf8');

  it.each(LOCALES)('%s has every string the gate can show', (_name, bundle) => {
    const missing = REQUIRED_KEYS.filter((key) => typeof bundle[key] !== 'string');

    expect(missing).toEqual([]);
  });

  it.each(LOCALES)('%s no longer carries the wording that claimed otherwise', (_name, bundle) => {
    const surviving = FORBIDDEN_KEYS.filter((key) => key in bundle);

    expect(surviving).toEqual([]);
  });

  it('translates every string it shows, rather than hardcoding one', () => {
    // A literal passed straight to `<ThemedText>` would pass the bundle checks
    // above by never being a key at all, and would ship English to all three.
    const asked = Array.from(source.matchAll(/\bt\(\s*'([^']+)'/g), ([, key]) => key);

    expect(asked.length).toBeGreaterThanOrEqual(REQUIRED_KEYS.length);
    expect(asked.filter((key) => !REQUIRED_KEYS.includes(key))).toEqual([]);
  });

  it('does not name the person as the thing that failed', () => {
    expect(source).not.toContain('could not sign you in');
  });
});
