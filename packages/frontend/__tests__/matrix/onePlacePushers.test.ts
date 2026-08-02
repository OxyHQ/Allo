import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Allo's push gateway must never receive a message, and this is the test that
 * keeps it that way.
 *
 * A pusher registered with the default format makes the homeserver send the
 * event's `content`, its `sender` and the room's name to the gateway on every
 * notification. In an encrypted room that content is ciphertext, which is
 * survivable; in any room the *metadata* is not, and in an unencrypted one the
 * content is the message itself. `event_id_only` is what stops all of it, and it
 * is one string in one place.
 *
 * The failure it prevents is invisible from anywhere: the notification still
 * arrives, on time, saying the same words, because Allo's gateway does not read
 * those fields. Nothing on the phone and nothing in the app looks different. The
 * only evidence is a log line on the server saying that fields it did not ask for
 * turned up — which is why `services/push/notification.ts` writes one.
 *
 * The native half is not checked for the format string, because its binding
 * cannot express another: `PushFormat` in the Rust enum has exactly one variant.
 * It is checked for a second call site, which is the other half of the guard.
 *
 * **If a second registration path is ever genuinely needed**, the change is not
 * to relax this. It is to add it here by name, so the next reader knows there
 * are two and why.
 */

const PORT_DIRECTORY = join(__dirname, '..', '..', 'lib', 'matrix');

/**
 * Reaching the homeserver's pusher registry, and the files allowed to.
 *
 * `setPusher` is named the same in both SDKs, so it has two homes — one per
 * platform — and each of those is checked below for exactly one call site. The
 * two removals are named differently by the two SDKs, so each has one.
 */
const REGISTRATIONS: readonly { readonly call: string; readonly onlyIn: readonly string[] }[] = [
  { call: 'setPusher', onlyIn: ['client.native.ts', 'client.web.ts'] },
  { call: 'removePusher', onlyIn: ['client.web.ts'] },
  { call: 'deletePusher', onlyIn: ['client.native.ts'] },
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

describe('registering a pusher', () => {
  const files = typeScriptFilesUnder(PORT_DIRECTORY);

  it('has source to check', () => {
    // Without this the suite passes cheerfully if the directory ever moves.
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(REGISTRATIONS)('calls $call from $onlyIn and nowhere else', ({ call, onlyIn }) => {
    const callSite = new RegExp(`\\.\\s*${call}\\s*\\(`, 'g');

    const callers = files
      .filter((file) => callSite.test(readFileSync(file, 'utf8')))
      .map((file) => relative(PORT_DIRECTORY, file))
      .sort();

    expect(callers).toEqual([...onlyIn].sort());
  });

  it('registers from exactly one place on native, where the format is the SDK\'s to choose', () => {
    const source = readFileSync(join(PORT_DIRECTORY, 'client.native.ts'), 'utf8');

    expect(source.match(/\.\s*setPusher\s*\(/g)).toHaveLength(1);
    // The binding's enum has one variant, so this is what "the format is not a
    // parameter" looks like on this platform.
    expect(source).toContain('PushFormat.EventIdOnly');
  });

  it('asks for event_id_only on web, where the SDK would accept anything', () => {
    const source = readFileSync(join(PORT_DIRECTORY, 'client.web.ts'), 'utf8');

    expect(source.match(/\.\s*setPusher\s*\(/g)).toHaveLength(1);
    expect(source).toContain("format: 'event_id_only'");
  });

  it('gives no caller a way to ask for another format', () => {
    // The other half of the guard. Even with one registration path per platform,
    // a `format` on the outgoing pusher would let a screen, a default argument or
    // a refactor turn the protection off — and nothing would look any different
    // afterwards, because the notification would still arrive.
    //
    // Property declarations only, not the whole body: prose about the format
    // belongs in this interface's doc comments and saying so must not fail a test
    // about what the interface *offers*.
    const contract = readFileSync(join(PORT_DIRECTORY, 'types.ts'), 'utf8');
    const pusher = contract.slice(contract.indexOf('export interface AlloPusher extends'));
    const properties = pusher
      .slice(0, pusher.indexOf('\n}'))
      .split('\n')
      .filter((line) => /^\s*(readonly\s+)?[A-Za-z_$][\w$]*\??\s*:/.test(line));

    expect(properties.length).toBeGreaterThan(3);
    expect(properties.filter((line) => /format|content|payload/i.test(line))).toEqual([]);
  });
});
