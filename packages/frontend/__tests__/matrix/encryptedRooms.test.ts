import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Allo cannot create an unencrypted room, and this is the test that keeps it
 * that way.
 *
 * `nativeCreateRoom.test.ts` and `web/createRoom.test.ts` prove that the two
 * parameter builders encrypt every shape of request. What they cannot prove is
 * that *every* room goes through them. The next person to add a "new
 * broadcast", a saved-messages room or a space will reach for `createRoom()`
 * directly — because that is what both SDKs document and what every other client
 * calls — and their room would be created, would sync, would draw identically,
 * and would have no encryption in it.
 *
 * That failure is invisible from inside the app. There is no error, nothing is
 * logged, and the padlock the UI draws comes from the room's own state, which
 * honestly says "not encrypted". Worse than a leaked upload: encryption in
 * Matrix is one-way, so the conversation cannot be repaired afterwards. Every
 * message in it, for as long as it exists, is readable by the homeserver.
 *
 * So this is a test, and it fails on a *second* call site rather than on a
 * broken one.
 *
 * **If a second way to create a room is ever genuinely needed**, the change is
 * not to relax this. It is to build its parameters in the same two modules, or
 * to give it its own builder with its own tests — and then to name it here, so
 * the next reader knows there are two and why.
 */

const PORT_DIRECTORY = join(__dirname, '..', '..', 'lib', 'matrix');

/** Where a room may be created, and where its parameters may be built. */
const CREATION: readonly {
  readonly what: string;
  readonly call: string;
  readonly onlyIn: string;
}[] = [
  { what: 'the room itself', call: 'createRoom', onlyIn: 'client.native.ts' },
  { what: 'the room itself', call: 'createRoom', onlyIn: 'client.web.ts' },
];

/** Where the parameters of a new room are decided, per platform. */
const BUILDERS: readonly {
  readonly what: string;
  readonly builder: string;
  readonly definedIn: string;
  readonly calledFrom: string;
}[] = [
  {
    what: 'the native parameters',
    builder: 'toCreateRoomParameters',
    definedIn: 'native/createRoom.ts',
    calledFrom: 'client.native.ts',
  },
  {
    what: 'the web options',
    builder: 'toCreateRoomOptions',
    definedIn: 'web/createRoom.ts',
    calledFrom: 'client.web.ts',
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

/** Call sites through a receiver — `something.createRoom(` — and not declarations. */
function callersOf(files: readonly string[], call: string): string[] {
  return files
    .filter((file) => new RegExp(`\\.\\s*${call}\\s*\\(`).test(readFileSync(file, 'utf8')))
    .map((file) => relative(PORT_DIRECTORY, file));
}

/**
 * Every file that names a function with an argument list after it.
 *
 * Unlike {@link callersOf} this catches the declaration too, which is what is
 * wanted for a plain function: the answer is "these files and no others", and
 * the file that defines it is necessarily one of them.
 */
function usesOf(files: readonly string[], name: string): string[] {
  return files
    .filter((file) => new RegExp(`\\b${name}\\s*\\(`).test(readFileSync(file, 'utf8')))
    .map((file) => relative(PORT_DIRECTORY, file));
}

describe('creating a room', () => {
  const files = typeScriptFilesUnder(PORT_DIRECTORY);

  it('has source to check', () => {
    // Without this the suite passes cheerfully if the directory ever moves.
    expect(files.length).toBeGreaterThan(10);
  });

  it('happens in the two client implementations and nowhere else', () => {
    expect(callersOf(files, 'createRoom').sort()).toEqual(
      CREATION.map((entry) => entry.onlyIn).sort(),
    );
  });

  it.each(CREATION)('calls $call once in $onlyIn', ({ call, onlyIn }) => {
    // Two call sites in one file means two places deciding what a room is, and
    // only one of them is the one the tests above read.
    const source = readFileSync(join(PORT_DIRECTORY, onlyIn), 'utf8');

    expect(source.match(new RegExp(`\\.\\s*${call}\\s*\\(`, 'g'))).toHaveLength(1);
  });

  it.each(BUILDERS)(
    'builds $what in $definedIn, called only from $calledFrom',
    ({ builder, definedIn, calledFrom }) => {
      // The builders are where the encryption above is asserted. A room built
      // anywhere else is a room nothing checked.
      expect(usesOf(files, builder).sort()).toEqual([definedIn, calledFrom].sort());
    },
  );

  it('never asks the binding for a room without encryption', () => {
    // The native half's encryption is one boolean. This is the assertion that
    // it is never written any way but one, anywhere in the port.
    const written = files.flatMap((file) => [
      ...readFileSync(file, 'utf8').matchAll(/isEncrypted\s*:\s*(\w+)/g),
    ]);

    expect(written.length).toBeGreaterThan(0);
    expect(written.map((match) => match[1])).toEqual(written.map(() => 'true'));
  });

  it('never creates a room that is public or that anybody can join', () => {
    // Both SDKs spell the mistake the same way, and either spelling turns an
    // invite-only family conversation into a room in the homeserver's public
    // directory.
    const offenders = files.filter((file) =>
      /\b(Preset|RoomPreset|Visibility|RoomVisibility)\.Public/.test(readFileSync(file, 'utf8')),
    );

    expect(offenders.map((file) => relative(PORT_DIRECTORY, file))).toEqual([]);
  });

  it('lets the people invited to a room join it, on both platforms', () => {
    // The other end of creating one. A port that could create a group and not
    // accept an invitation to it would be a port that makes conversations only
    // their creator can use — and a UI that can draw an invitation but not
    // answer it is a row that does nothing when it is tapped.
    //
    // Both halves, because a method only one SDK answers is the abstraction
    // breaking; see the note at the top of `types.ts`.
    for (const half of ['client.native.ts', 'client.web.ts']) {
      const source = readFileSync(join(PORT_DIRECTORY, half), 'utf8');
      expect(source).toMatch(/async acceptInvitation\(roomId: string\): Promise<void>/);
      expect(source).toMatch(/async declineInvitation\(roomId: string\): Promise<void>/);
    }
  });

  it('gives no caller a way to ask for an unencrypted room', () => {
    // The other half of the guard, and the one that matters most: even with one
    // creation path per platform, an `isEncrypted: boolean` on the request would
    // let a screen, a default argument or a refactor turn it off — and nothing
    // in the app would look any different afterwards.
    //
    // Property declarations only, not the whole body: prose about encryption
    // belongs in this interface's doc comments and saying so must not fail a
    // test about what the interface *offers*.
    const contract = readFileSync(join(PORT_DIRECTORY, 'types.ts'), 'utf8');
    const outgoing = contract.slice(contract.indexOf('export interface AlloCreateRoomRequest'));
    const properties = outgoing
      .slice(0, outgoing.indexOf('\n}'))
      .split('\n')
      .filter((line) => /^\s*(readonly\s+)?[A-Za-z_$][\w$]*\??\s*:/.test(line));

    expect(properties.length).toBeGreaterThan(2);
    expect(
      properties.filter((line) => /encrypt|plaintext|clear|public|visib/i.test(line)),
    ).toEqual([]);
  });
});
