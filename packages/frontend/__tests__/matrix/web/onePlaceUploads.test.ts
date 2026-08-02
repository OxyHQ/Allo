import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * There is one door to the homeserver's media repository, and this is the test
 * that keeps it the only one.
 *
 * `attachments.test.ts` proves that {@link resolveAttachmentSource} encrypts
 * when the room is encrypted and refuses when it does not know. What it cannot
 * prove is that *everything* goes through it. The next person to add a document
 * picker, an avatar upload or a sticker will reach for `uploadContent()` —
 * because that is what `matrix-js-sdk` documents and what every other client
 * calls — and their upload would be correct, would work, and would put the file
 * on the homeserver in the clear.
 *
 * That failure is invisible from inside the app: the event is still encrypted,
 * the bubble is identical, nothing is logged. So this is a test, and it fails on
 * a second call site rather than on a broken one.
 *
 * **If a second upload path is ever genuinely needed**, the change is not to
 * relax this. It is to route it through `resolveAttachmentSource` too, or to
 * give it its own decision point with its own tests — and then to add it here by
 * name so the next reader knows there are two and why.
 */

const PORT_DIRECTORY = join(__dirname, '..', '..', '..', 'lib', 'matrix');

/**
 * Ways to put bytes into the media repository, and the one file allowed to use
 * each.
 *
 * The native half is absent from this list on purpose: `Timeline.sendImage` and
 * its siblings upload *and* encrypt inside Rust, reading the room's state
 * themselves, so there is no plaintext path there to guard.
 */
const UPLOADS: readonly { readonly call: string; readonly onlyIn: string }[] = [
  { call: 'uploadContent', onlyIn: 'client.web.ts' },
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

describe('uploading to the media repository', () => {
  const files = typeScriptFilesUnder(PORT_DIRECTORY);

  it('has source to check', () => {
    // Without this the suite passes cheerfully if the directory ever moves.
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(UPLOADS)('calls $call from $onlyIn and nowhere else', ({ call, onlyIn }) => {
    const callSite = new RegExp(`\\.\\s*${call}\\s*\\(`, 'g');

    const callers = files
      .filter((file) => callSite.test(readFileSync(file, 'utf8')))
      .map((file) => relative(PORT_DIRECTORY, file));

    expect(callers).toEqual([onlyIn]);
  });

  it.each(UPLOADS)('calls $call exactly once, from the port\'s one uploader', ({ call, onlyIn }) => {
    const source = readFileSync(join(PORT_DIRECTORY, onlyIn), 'utf8');

    // Two call sites means two places deciding whether to encrypt, and only one
    // of them is covered by `attachments.test.ts`.
    expect(source.match(new RegExp(`\\.\\s*${call}\\s*\\(`, 'g'))).toHaveLength(1);
  });

  it('gives no caller a way to ask for an unencrypted upload', () => {
    // The other half of the guard. Even with one upload path, an
    // `isEncrypted: boolean` on the outgoing attachment would let a screen, a
    // default argument or a refactor turn encryption off — and the room's own
    // state is the only honest source for that answer.
    const contract = readFileSync(join(PORT_DIRECTORY, 'types.ts'), 'utf8');
    const outgoing = contract.slice(
      contract.indexOf('export interface AlloOutgoingAttachment'),
    );
    const body = outgoing.slice(0, outgoing.indexOf('\n}'));

    expect(body).not.toMatch(/encrypt/i);
    expect(body).not.toMatch(/plaintext/i);
  });
});
