import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * There is one way to start a conversation, and this is the test that keeps it
 * the only one.
 *
 * The two creators are deliberately not interchangeable — one POSTs to Allo's
 * API and writes to a Zustand store, the other invites MXIDs on a homeserver
 * and writes to nothing — and `hooks/useCreateConversation.ts` is where
 * `EXPO_PUBLIC_CHAT_BACKEND` chooses between them. A screen that imported one
 * directly would work in the build it was written for and silently do nothing
 * useful in the other: on Matrix it would create a conversation in a Mongo
 * collection the app is not reading, and on `allo-api` it would ask a client
 * that was never started.
 *
 * So this fails on a second importer rather than on a broken one.
 *
 * **What this does not claim.** `app/(chat)/c/[id].tsx` still creates a direct
 * conversation of its own when a user id is deep-linked into `/c/:id`, over the
 * Express API. That path is legacy-only — its Matrix counterpart deliberately
 * creates nothing, because a room comes from sync — and it is not reached from
 * the New Chat screen. Unifying it is its own change.
 */

const FRONTEND = join(__dirname, '..', '..');

/** Each creator, and the one module allowed to reach it. */
const CREATORS: readonly { readonly module: string; readonly importedOnlyBy: string }[] = [
  {
    module: '@/lib/chat/matrixConversations',
    importedOnlyBy: join('hooks', 'useCreateConversation.ts'),
  },
  {
    module: '@/lib/chat/alloApiConversations',
    importedOnlyBy: join('hooks', 'useCreateConversation.ts'),
  },
];

const SOURCE_DIRECTORIES = ['app', 'components', 'hooks', 'lib', 'stores', 'utils', 'features'];

function sourceFilesUnder(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
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

describe('creating a conversation', () => {
  const files = SOURCE_DIRECTORIES.flatMap((directory) =>
    sourceFilesUnder(join(FRONTEND, directory)),
  ).map((file) => relative(FRONTEND, file));

  it('has source to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(CREATORS)('reaches $module only from $importedOnlyBy', ({ module, importedOnlyBy }) => {
    const imports = new RegExp(`from '${module}'`);
    const importers = files.filter(
      (file) =>
        // Its own module is not an importer of itself.
        !file.startsWith(module.replace('@/', '')) &&
        imports.test(readFileSync(join(FRONTEND, file), 'utf8')),
    );

    expect(importers).toEqual([importedOnlyBy]);
  });

  it('gives the screens a seam that does not name a backend', () => {
    // The hook's type is the whole contract the screen sees: people in, an id
    // out. A screen that had to know which backend answered would be a screen
    // with two code paths, which is what the flag exists to avoid.
    const seam = readFileSync(join(FRONTEND, 'lib', 'chat', 'newConversation.ts'), 'utf8');

    expect(seam).toContain(
      'export type ConversationCreator = (request: NewConversationRequest) => Promise<string>;',
    );
  });
});
