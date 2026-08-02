import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The port is the app's only door to a Matrix SDK, and this is what keeps it
 * the only one.
 *
 * `lib/matrix/types.ts` is a contract written in Allo's own view models
 * precisely so that no screen, hook or store has to know what a room is. An
 * import of either SDK anywhere else would end that quietly: the code would
 * work, the app would run, and from then on there would be two definitions of
 * what a conversation is — one of them platform-specific, because the two SDKs
 * agree on almost nothing. The web bundle would also start carrying
 * `matrix-js-sdk` in builds whose flag says `allo-api`, which is the one thing
 * `lib/chat/backend.ts` exists to prevent.
 *
 * `lib/matrix/**` is where both SDKs are allowed, and nowhere else is.
 */

const FRONTEND = join(__dirname, '..', '..');

/** Every directory of the app's own source. */
const SOURCE_DIRECTORIES = [
  'app',
  'components',
  'hooks',
  'lib',
  'stores',
  'utils',
  'features',
  'src',
  'services',
  'constants',
  'contexts',
  'styles',
] as const;

/** The one place either SDK may be imported. */
const PORT_PREFIX = join('lib', 'matrix') + sep;

const SDK_IMPORT = /from\s+'(@unomed\/react-native-matrix-sdk|matrix-js-sdk)[^']*'/;

function sourceFilesUnder(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    // A directory this app does not have. The list above is deliberately
    // generous: a directory that appears later is covered without anybody
    // remembering to add it, and one that never existed costs nothing.
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourceFilesUnder(path);
    }
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the Matrix port boundary', () => {
  const files = SOURCE_DIRECTORIES.flatMap((directory) =>
    sourceFilesUnder(join(FRONTEND, directory)),
  ).map((file) => relative(FRONTEND, file));

  it('has source to check', () => {
    expect(files.length).toBeGreaterThan(100);
    // And the port itself is in it, so the exclusion below is excluding
    // something rather than describing a directory that moved.
    expect(files.filter((file) => file.startsWith(PORT_PREFIX)).length).toBeGreaterThan(10);
  });

  it('imports a Matrix SDK only inside lib/matrix', () => {
    const offenders = files
      .filter((file) => !file.startsWith(PORT_PREFIX))
      .filter((file) => SDK_IMPORT.test(readFileSync(join(FRONTEND, file), 'utf8')));

    expect(offenders).toEqual([]);
  });
});
