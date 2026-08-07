import { Directory, Paths } from 'expo-file-system';

import { MatrixStoreNotErasedError, MatrixStoreUnavailableError } from '@/lib/matrix/errors';
import type { AlloChatStoreEraser, AlloClientStore } from '@/lib/matrix/types';

/**
 * Where the native client keeps its data, and how to get rid of it.
 *
 * Metro serves this file on iOS and Android and `store.web.ts` on web; both
 * answer the same two names, and everything above them is written against those
 * rather than against a filesystem.
 *
 * The Rust SDK's own words on the paths it is given are that they "**must** be
 * unique per session as the SDK stores aren't capable of handling multiple
 * users". Allo has one session at a time, so one pair of paths is enough — but
 * only if a session's store never outlives the session. That is what
 * {@link eraseAlloChatStore} is for, and why the runtime erases before it builds
 * a client it has no session for.
 */

/** The directory, inside the app's own document and cache directories. */
const STORE_DIRECTORY = 'matrix';

const FILE_SCHEME = 'file://';

/**
 * The state store and the event cache.
 *
 * Two directories and not one, in the two places the platform means them to be:
 * the state store holds the device's encryption keys and belongs where the system
 * will not reclaim it, and the event cache is a cache — losing it costs a
 * re-sync, and a phone running out of space should be allowed to take it.
 */
export function resolveAlloChatStore(): AlloClientStore {
  return {
    kind: 'filesystem',
    dataPath: toFilesystemPath(new Directory(Paths.document, STORE_DIRECTORY)),
    cachePath: toFilesystemPath(new Directory(Paths.cache, STORE_DIRECTORY)),
  };
}

/**
 * Deletes both directories, and everything the SDK put in them.
 *
 * The SQLite files may still be open when this runs — the client that owns them
 * is closed first, but the Rust object behind it is released by a garbage
 * collector nothing here can wait for. Deleting them anyway is safe and is the
 * point: on both platforms unlinking a file that is open removes it from the
 * filesystem immediately, and whatever still holds it writes to something no path
 * leads to. What must not happen is the directory surviving, because a client
 * built afterwards would open it.
 *
 * So the directory is checked again afterwards rather than assumed gone, and a
 * survivor is raised as {@link MatrixStoreNotErasedError}. `delete()` throwing is
 * the loud failure and is left to propagate; this is the quiet one — a delete
 * that reports nothing and removes nothing — and it is the one that ends with the
 * next account opening the last account's keys. Both directories are attempted
 * before anything is raised, so a state store that cannot go does not also leave
 * the event cache behind.
 */
export const eraseAlloChatStore: AlloChatStoreEraser = async (store) => {
  if (store.kind === 'in-memory') {
    return;
  }
  const remaining: string[] = [];
  // A set, because a deployment is free to point both at one directory: the SDK
  // allows it, and deleting the same directory twice would throw on the second.
  for (const path of new Set([store.dataPath, store.cachePath])) {
    const directory = new Directory(toDirectoryUri(path));
    if (directory.exists) {
      directory.delete();
    }
    if (directory.exists) {
      remaining.push(path);
    }
  }
  if (remaining.length > 0) {
    throw new MatrixStoreNotErasedError(remaining);
  }
};

/**
 * The plain path the Rust SDK speaks, from the URI expo-file-system speaks.
 *
 * The SDK takes an operating system path — it hands it to SQLite — and
 * expo-file-system answers in `file://` URIs, so the percent-encoding a URI
 * carries has to come off.
 */
function toFilesystemPath(directory: Directory): string {
  const { uri } = directory;
  if (!uri.startsWith(FILE_SCHEME)) {
    throw new MatrixStoreUnavailableError(
      `this platform put the app's storage at "${uri}", which is not a local ` +
        'file and cannot be given to the SDK as a path',
    );
  }
  return decodeURIComponent(uri.slice(FILE_SCHEME.length));
}

/**
 * The reverse, for the one call that takes a URI rather than a path.
 *
 * `encodeURI` and not `encodeURIComponent`: the separators have to survive. What
 * it leaves alone is `#` and `?`, which a URI would read as the start of a
 * fragment or a query — so a path containing either is refused here rather than
 * silently naming a different directory, which is the one mistake this function
 * could make that ends in deleting nothing and reporting success.
 */
function toDirectoryUri(path: string): string {
  if (path.includes('#') || path.includes('?')) {
    throw new MatrixStoreUnavailableError(
      `"${path}" cannot be addressed as a file URI, because "#" and "?" mean ` +
        'something else in one',
    );
  }
  return `${FILE_SCHEME}${encodeURI(path)}`;
}
