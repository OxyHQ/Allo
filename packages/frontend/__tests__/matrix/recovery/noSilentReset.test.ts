import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The operations that break the link to Oxy, and the check that keeps them out.
 *
 * Both SDKs offer a handful of calls that replace the 4S key with random bytes
 * or delete it outright. None of them fails, none of them warns, and after any
 * of them the passphrase derived from the user's Oxy identity opens nothing —
 * the account's history is behind a key that was never shown to anybody. See
 * `docs/matrix/client-strategy.md` §3.2.
 *
 * A comment saying "do not call these" is worth very little: the next person to
 * add a "reset my encryption" screen will reach for exactly these names, because
 * they are what every other Matrix client uses. So this is a test. It reads the
 * port's own source and fails on a call to any of them.
 *
 * **How to write about these calls without failing this test.** The check looks
 * for a call *through a receiver* — `something.resetRecoveryKey(` — so prose and
 * doc comments naming them bare, as this file's own comments do, are fine. That
 * is deliberate: the alternative is stripping comments before scanning, which
 * quietly stops working the first time a string literal contains a slash.
 *
 * **If one of these is ever genuinely needed**, the change is not to loosen this
 * test. It is to work out what happens to the history first, put it in the
 * design, and give the user a way to keep reading their messages afterwards.
 */

const PORT_DIRECTORY = join(__dirname, '..', '..', '..', 'lib', 'matrix');

/** Method names that silently sever the link, and why each one does. */
const FORBIDDEN: readonly { readonly method: string; readonly effect: string }[] = [
  {
    method: 'resetRecoveryKey',
    effect: 'replaces the 4S key with 32 random bytes and drops the passphrase block',
  },
  {
    method: 'recoverAndReset',
    effect: 'opens 4S with the old key and then replaces it with a random one',
  },
  {
    method: 'disableRecovery',
    effect: 'deletes 4S and the key backup from the account',
  },
  {
    method: 'resetIdentity',
    effect: 'throws away the cross-signing identity, the backup and the recovery key',
  },
  {
    method: 'resetEncryption',
    effect: 'the web SDK’s equivalent of a full identity reset',
  },
  {
    method: 'deleteSecretStorage',
    effect: 'removes the 4S key and every secret stored under it',
  },
  {
    method: 'resetKeyBackup',
    effect:
      'mints a new backup version, stranding every room key that only the old one holds',
  },
];

function typeScriptFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return typeScriptFilesUnder(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('the Matrix port', () => {
  const files = typeScriptFilesUnder(PORT_DIRECTORY);

  it('has source to check', () => {
    // Without this the suite passes cheerfully if the directory ever moves.
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(FORBIDDEN)('never calls $method, which $effect', ({ method }) => {
    const callSite = new RegExp(`\\.\\s*${method}\\s*\\(`);

    const offenders = files.filter((file) => callSite.test(readFileSync(file, 'utf8')));

    expect(offenders.map((file) => relative(PORT_DIRECTORY, file))).toEqual([]);
  });

  it('offers no way to reach them from outside either', () => {
    // The port is the app's only door to a Matrix SDK, so a method it does not
    // expose is a method no screen can call. This asserts the door stays shut:
    // the contract's recovery surface is these three and nothing more.
    const contract = readFileSync(join(PORT_DIRECTORY, 'types.ts'), 'utf8');

    expect(contract).toContain('recoveryState(): Promise<AlloRecoveryState>;');
    expect(contract).toContain('enableRecovery(passphrase: string): Promise<void>;');
    expect(contract).toContain('recoverWithPassphrase(passphrase: string): Promise<void>;');

    for (const { method } of FORBIDDEN) {
      expect(contract).not.toMatch(new RegExp(`^\\s*${method}\\s*\\(`, 'm'));
    }
  });
});
