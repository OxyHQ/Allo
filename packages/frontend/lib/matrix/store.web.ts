import { MatrixStoreNotErasedError, MatrixStoreUnavailableError } from '@/lib/matrix/errors';
import type { AlloChatStoreEraser, AlloClientStore } from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

/**
 * Where the web client keeps its data, and how to get rid of it.
 *
 * Metro serves this file on web and `store.native.ts` on iOS and Android; both
 * answer the same two names. What differs is what a store *is*: a browser has no
 * filesystem, so the port's `dataPath` names an IndexedDB database rather than a
 * directory, and `cachePath` has nothing to name.
 *
 * Two databases hang off that name and they are not symmetrical:
 *
 * - **the synced state**, named after the store and nothing else, so a client
 *   built with the same configuration opens the same one whichever session it is
 *   for. That is what makes erasing before a new session necessary here.
 * - **the crypto store**, named after the store *and the device*, so it can only
 *   ever be opened by the device that wrote it. A leftover cannot be inherited by
 *   a new session — it can only take up space, which is why erasing it is
 *   housekeeping rather than correctness.
 *
 * Both are deleted here, and neither is deleted while a client is using it. Allo
 * on web is safe in one tab and untested in two (`client.web.ts`), and a second
 * tab holding a live session is one of the things that is untested.
 *
 * **A deletion that is refused is a failure, and it is raised.** Erasing is how
 * `matrixRuntime.ts` keeps one identity's synced state and keys away from the
 * next one, so reporting success for a database that is still there would hand
 * the next account exactly what this exists to take away. Every candidate is
 * still attempted before the failure is raised — stopping at the first refusal
 * would leave behind databases that could have gone — and what is raised names
 * the ones that did not.
 */

const LOG_TAG = '[matrix]';

/** The IndexedDB database name. Also the crypto databases' first component. */
const STORE_NAME = 'allo-matrix';

/** What `matrix-js-sdk` puts in front of the name it is given. */
const SYNC_DATABASE_PREFIX = 'matrix-js-sdk:';

/** What the Rust crypto machine puts after the prefix it is given. */
const CRYPTO_DATABASE_SUFFIXES = ['::matrix-sdk-crypto', '::matrix-sdk-crypto-meta'];

export function resolveAlloChatStore(): AlloClientStore {
  // The same string twice: `cachePath` exists for the native SDK, which keeps its
  // event cache in a second directory. There is no second database here.
  return { kind: 'filesystem', dataPath: STORE_NAME, cachePath: STORE_NAME };
}

/**
 * What `matrix-js-sdk` will call the database holding the synced state.
 *
 * Its own function because the eraser has to name the same database the store
 * did, and the SDK's prefix is not something either end can be trusted to
 * remember separately.
 */
export function syncDatabaseName(dataPath: string): string {
  return `${SYNC_DATABASE_PREFIX}${dataPath}`;
}

/**
 * What the crypto databases are named after, for one device.
 *
 * Keyed by device because a crypto store belongs to exactly one: the SDK refuses
 * to open one written by a different device, and a fresh install that inherited
 * the last one would be holding keys for an identity the homeserver has never
 * heard of.
 */
export function cryptoDatabasePrefix(dataPath: string, deviceId: string): string {
  return `${dataPath}:${deviceId}`;
}

export const eraseAlloChatStore: AlloChatStoreEraser = (store) =>
  eraseWebStore(store, globalThis.indexedDB);

/**
 * The eraser, with the browser's IndexedDB handed in.
 *
 * Injected rather than read from `globalThis` so that the deletion — which
 * databases, in what order, and what a refusal does — can be exercised without a
 * browser.
 */
export async function eraseWebStore(
  store: AlloClientStore,
  indexedDB: IDBFactory | undefined,
): Promise<void> {
  if (store.kind === 'in-memory') {
    return;
  }
  if (indexedDB === undefined) {
    throw new MatrixStoreUnavailableError(
      'this browser exposes no IndexedDB, so the databases a previous session ' +
        'may have left cannot be deleted',
    );
  }

  const names = new Set([syncDatabaseName(store.dataPath)]);
  for (const name of await cryptoDatabaseNames(store.dataPath, indexedDB)) {
    names.add(name);
  }

  const remaining: string[] = [];
  for (const name of names) {
    if (!(await deleteDatabase(name, indexedDB))) {
      remaining.push(name);
    }
  }
  if (remaining.length > 0) {
    throw new MatrixStoreNotErasedError(remaining);
  }
}

/**
 * The crypto databases this store has left behind, whichever devices wrote them.
 *
 * `databases()` is what makes this possible and not every browser has it —
 * Firefox only from 126. Without it the leftovers are not found, which costs
 * storage and nothing else: a crypto database is named after the device that
 * wrote it, so one that is still there cannot be opened by the session that comes
 * next. The one that matters for correctness is the synced state, and that one is
 * named without asking the browser anything.
 */
async function cryptoDatabaseNames(
  dataPath: string,
  indexedDB: IDBFactory,
): Promise<readonly string[]> {
  if (typeof indexedDB.databases !== 'function') {
    return [];
  }

  const found: string[] = [];
  const existing = await indexedDB.databases();
  for (const { name } of existing) {
    if (name === undefined) {
      continue;
    }
    for (const suffix of CRYPTO_DATABASE_SUFFIXES) {
      if (name.startsWith(`${dataPath}:`) && name.endsWith(suffix)) {
        found.push(name);
      }
    }
  }
  return found;
}

/**
 * Deletes one database, and says whether it went.
 *
 * `false` rather than a throw, so that a refusal does not stop the databases
 * after it from being attempted. The caller collects the refusals and raises one
 * failure naming all of them.
 *
 * A deletion can be *blocked* rather than refused, which is a connection
 * somewhere else still holding the database open — another tab. It is reported
 * and waited out rather than treated as an error, because the request stays
 * pending and completes when the other connection closes. Waiting is the right
 * answer and it is also the safe one: the caller is holding off a client that
 * would otherwise open this database, and a launch that hangs with a line in the
 * log beats one that proceeds into somebody else's keys.
 */
function deleteDatabase(name: string, indexedDB: IDBFactory): Promise<boolean> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      resolve(true);
    };
    request.onerror = () => {
      // A browser whose `indexedDB` refuses mutations — some private windows do
      // — cannot have its store erased, and cannot be allowed to reopen one.
      logger.warn(`${LOG_TAG} the database ${name} could not be deleted`, request.error);
      resolve(false);
    };
    request.onblocked = () => {
      logger.warn(
        `${LOG_TAG} the database ${name} is still open somewhere else; it will ` +
          'be deleted when that connection closes',
      );
    };
  });
}
