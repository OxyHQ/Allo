import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Every way an encrypted event leaves Allo goes through the ephemeral guard, and
 * this is the test that keeps it that way.
 *
 * `guard.test.ts` proves the guard refuses what it should. What it cannot prove
 * is that anything *asks* it. The next person to add a poll, a location, a
 * sticker or a "send again" button will reach for the SDK the way every other
 * send in these files does, and their event would go into an ephemeral
 * conversation with no check at all — reaching every device of every
 * participant, including one whose owner has published no identity, and staying
 * there after the redaction that the conversation's whole promise rests on.
 *
 * That failure is invisible from inside the app: the message sends, the bubble
 * looks right, and the row disappears at its deadline exactly as it should. The
 * only thing that changed is who has a copy.
 *
 * So this reads the source of both halves of the port and pins down which
 * methods are guarded and which deliberately are not. It follows
 * `encryptedRooms.test.ts` and `web/onePlaceUploads.test.ts`, and for the same
 * reason: it fails on a *new* call site rather than on a broken one.
 *
 * **If a fifth send is genuinely needed**, the change is not to relax this. It
 * is to guard it and name it below, so the next reader knows there are five.
 */

const PORT_DIRECTORY = join(__dirname, '..', '..', '..', 'lib', 'matrix');

/** The call every guarded send begins with. */
const GUARD_CALL = 'requireSendable';

const HALVES = ['client.native.ts', 'client.web.ts'] as const;

/**
 * The four operations that put a new encrypted event in a room.
 *
 * A reaction is on the list because half of what `toggleReaction` does is send
 * one: an `m.annotation` in an encrypted room is encrypted with the room key
 * like everything else, and it says who reacted to what.
 */
const GUARDED = ['sendText', 'sendAttachment', 'toggleReaction', 'edit'] as const;

/**
 * What must **not** be guarded, and why.
 *
 * `redact` is the mechanism the whole tier rests on. A rule that blocked it in a
 * conversation whose participants could not be accounted for would keep content
 * alive on the homeserver in order to protect it, which is precisely backwards.
 *
 * A read receipt and a typing notice carry nothing of the conversation and are
 * not encrypted; refusing them would leak the refusal without protecting
 * anything.
 */
const UNGUARDED = ['redact', 'sendReadReceipt', 'sendTypingNotice'] as const;

/** The body of a method, from its signature to the line that closes it. */
function methodBody(source: string, name: string): string {
  const start = source.search(new RegExp(`^  async ${name}\\(|^  ${name}\\(`, 'm'));
  if (start === -1) {
    throw new Error(`no method ${name} in the source given`);
  }
  const end = source.indexOf('\n  }', start);
  if (end === -1) {
    throw new Error(`the method ${name} does not end`);
  }
  return source.slice(start, end);
}

function halfSource(half: string): string {
  return readFileSync(join(PORT_DIRECTORY, half), 'utf8');
}

function typeScriptFilesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return typeScriptFilesUnder(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('the ephemeral send gate', () => {
  it.each(HALVES)('has a timeline in %s to check', (half) => {
    // Without this the suite passes cheerfully if a method is ever renamed.
    const source = halfSource(half);
    for (const name of [...GUARDED, ...UNGUARDED]) {
      expect(() => methodBody(source, name)).not.toThrow();
    }
  });

  describe.each(HALVES)('%s', (half) => {
    it.each(GUARDED)('guards %s', (name) => {
      expect(methodBody(halfSource(half), name)).toContain(GUARD_CALL);
    });

    it.each(UNGUARDED)('does not guard %s', (name) => {
      // Not an omission. See the note on UNGUARDED above.
      expect(methodBody(halfSource(half), name)).not.toContain(GUARD_CALL);
    });

    it('guards before it does anything else', () => {
      // An attachment refused after the upload would leave the bytes on the
      // homeserver with no event pointing at them — and in an ephemeral
      // conversation the bytes are the thing being protected.
      const body = methodBody(halfSource(half), 'sendAttachment');
      const lines = body.split('\n').filter((line) => /\bawait\b/.test(line));

      expect(lines[0]).toContain(GUARD_CALL);
    });

    it('asks the guard once per send and no more', () => {
      const source = halfSource(half);
      for (const name of GUARDED) {
        expect(methodBody(source, name).match(new RegExp(GUARD_CALL, 'g'))).toHaveLength(1);
      }
    });
  });

  it('builds the guard in the two client implementations and nowhere else', () => {
    // A second guard would be a second set of dependencies, and the one that was
    // wired to nothing would let everything through.
    const files = typeScriptFilesUnder(PORT_DIRECTORY);
    const builders = files
      .filter((file) => /new EphemeralSendGuard\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(PORT_DIRECTORY, file));

    expect(builders.sort()).toEqual([...HALVES].sort());
  });

  it('has no way to build a client that skips it', () => {
    // The guard is a required constructor argument of each timeline handle, not
    // an optional one with a permissive default. An optional guard is a guard
    // the next caller forgets.
    for (const half of HALVES) {
      const source = halfSource(half);
      expect(source).toMatch(/ephemeral: EphemeralSendGuard,/);
      expect(source).not.toMatch(/ephemeral\?: EphemeralSendGuard/);
    }
  });
});
