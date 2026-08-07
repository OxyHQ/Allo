import {
  MatrixStoreEraseBlockedError,
  MatrixStoreNotErasedError,
  MatrixStoreUnavailableError,
} from '@/lib/matrix/errors';
import type {
  AlloChatStoreEraser,
  AlloClientStore,
  AlloStoreEraseObserver,
} from '@/lib/matrix/types';
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
 *
 * **A deletion that is BLOCKED is a different thing, and it is the one a person
 * meets.** IndexedDB refuses to delete a database another connection still has
 * open and leaves the request pending; the request completes on its own the
 * moment that connection closes. So the erase waits, because waiting is both the
 * behaviour that recovers and the only safe one — the caller is holding off a
 * client that would otherwise open this database. What it does NOT do any more
 * is wait in silence and wait forever. It says so through
 * {@link AlloStoreEraseObserver} as soon as it starts waiting, so the launch can
 * put a sentence on screen instead of a spinner, says so again if the wait ends
 * by itself, and gives up after {@link BLOCKED_DELETION_TIMEOUT_MS} by raising
 * {@link MatrixStoreEraseBlockedError}. Giving up is a REFUSAL TO CONTINUE and
 * never a fall-through: the store that could not be emptied is not opened.
 *
 * ## Why "another window", inferred rather than proven
 *
 * `onblocked` says a connection exists; it does not say whose. The Web Locks API
 * and `BroadcastChannel` were both considered for saying it with certainty, and
 * neither can here: each needs a live participant *in the other window* — a lock
 * held or a listener answering — which means every tab holding a client would
 * have to register one, and that is the two-tab guard `client.web.ts` documents
 * as absent and out of scope. A probe nobody answers proves nothing.
 *
 * What makes the inference safe enough to put on screen instead: IndexedDB is
 * scoped to an origin, and these database names are Allo's own, built by this
 * module. Nothing but Allo opens them, and the only place Allo runs on this
 * origin is one of its own browsing contexts. The one case that is NOT another
 * window is a client this tab closed a moment ago —
 * `MatrixClient.stopClient()` does not close its `IndexedDBStore` — which the
 * runtime can reach through `#startOver`. The copy is a request to close other
 * windows, so the worst that case costs is a suggestion that does not help,
 * ending at the bound in a screen with a button; before this it ended nowhere.
 */

const LOG_TAG = '[matrix]';

/**
 * How long a deletion is allowed to wait for another connection to let go.
 *
 * Long enough for somebody who has just been told to go and close another window
 * to find it and close it, and to have the launch carry on the moment they do —
 * this bound is not the common ending, the other window closing is. Short enough
 * that a window they cannot find, or one the browser is holding in a state they
 * cannot see, does not leave them in front of a screen that never changes.
 *
 * A deletion that is not blocked has no timer at all: it either succeeds or
 * errors, promptly and on its own. Blocked is the one outcome IndexedDB never
 * settles by itself, which is why it is the one outcome that is bounded.
 */
export const BLOCKED_DELETION_TIMEOUT_MS = 30_000;

/** Reports nothing, for the callers that have no screen to draw. */
const IGNORE_BLOCKED: AlloStoreEraseObserver = () => {};

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

export const eraseAlloChatStore: AlloChatStoreEraser = (store, onBlocked) =>
  eraseWebStore(store, globalThis.indexedDB, { onBlocked });

/** What an erase can be told beyond which store to empty. */
export interface WebStoreEraseOptions {
  /** Told when a deletion starts and stops waiting on another connection. */
  readonly onBlocked?: AlloStoreEraseObserver;
  /**
   * How long one blocked deletion is waited out.
   *
   * Overridable for the same reason `indexedDB` is injected: a case about what
   * happens at the bound should not take {@link BLOCKED_DELETION_TIMEOUT_MS}
   * of wall clock to make its point. The app never passes it.
   */
  readonly blockedTimeoutMs?: number;
}

/**
 * The eraser, with the browser's IndexedDB handed in.
 *
 * Injected rather than read from `globalThis` so that the deletion — which
 * databases, in what order, what a refusal does and what a block does — can be
 * exercised without a browser.
 */
export async function eraseWebStore(
  store: AlloClientStore,
  indexedDB: IDBFactory | undefined,
  options: WebStoreEraseOptions = {},
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

  const onBlocked = options.onBlocked ?? IGNORE_BLOCKED;
  const blockedTimeoutMs = options.blockedTimeoutMs ?? BLOCKED_DELETION_TIMEOUT_MS;

  const remaining: string[] = [];
  for (const name of names) {
    // A block, unlike a refusal, stops the loop rather than being collected:
    // every database left would have to be waited out for the same bound, and
    // several minutes of a screen that cannot change is not a better answer than
    // one. It throws from here, so nothing below runs and nothing opens a store.
    if (!(await deleteDatabase(name, indexedDB, onBlocked, blockedTimeoutMs))) {
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
 * somewhere else still holding the database open. The request stays pending and
 * completes on its own when that connection closes, so this waits — the caller
 * is holding off a client that would otherwise open this database, and a launch
 * that waits beats one that proceeds into somebody else's keys.
 *
 * Three things make that wait something a person can live through rather than a
 * hang:
 *
 * - it is **announced**, through `onBlocked`, the moment the browser says so;
 * - it **ends by itself** when the other connection closes, which is the common
 *   ending: `onsuccess` arrives, `onBlocked(false)` is reported, and the launch
 *   carries on with nothing reloaded and nothing asked of anybody;
 * - it is **bounded**, and at the bound it THROWS. Never resolves. A resolution
 *   would be read by the caller as "the store is empty", which is the one thing
 *   it is not.
 *
 * `onBlocked(false)` is deliberately not reported on the timeout path: the
 * caller is about to be handed a failure and told to draw it, and a "carry on"
 * a tick before that is a screen that flickers back to a spinner it will never
 * leave.
 *
 * The pending request is not cancelled at the bound — IndexedDB has no way to —
 * so it outlives the failure and may complete a minute later. That is fine and
 * even useful: it still deletes the database, which is the state the next
 * attempt wants. What must not happen is anything about it reaching a caller
 * whose launch has moved on, which is what {@link settled} is for. It guards the
 * one handler that can *say* something on its own — a browser is allowed to
 * report `onblocked` more than once, and one arriving after this deletion is
 * over would put "another window has your data" in front of somebody who is past
 * it, and start a timer that outlives the page.
 */
function deleteDatabase(
  name: string,
  indexedDB: IDBFactory,
  onBlocked: AlloStoreEraseObserver,
  blockedTimeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    /** Whether this deletion has an answer. A promise's own settling is not enough: see below. */
    let settled = false;
    let waiting: ReturnType<typeof setTimeout> | undefined;

    /** Ends the wait, if there was one, and says so unless we are giving up. */
    const stopWaiting = (announce: boolean): void => {
      if (waiting === undefined) {
        return;
      }
      clearTimeout(waiting);
      waiting = undefined;
      if (announce) {
        onBlocked(false);
      }
    };

    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      settled = true;
      stopWaiting(true);
      resolve(true);
    };
    request.onerror = () => {
      settled = true;
      stopWaiting(true);
      // A browser whose `indexedDB` refuses mutations — some private windows do
      // — cannot have its store erased, and cannot be allowed to reopen one.
      logger.warn(`${LOG_TAG} the database ${name} could not be deleted`, request.error);
      resolve(false);
    };
    request.onblocked = () => {
      // Once, and only while this deletion is still the live question.
      if (settled || waiting !== undefined) {
        return;
      }
      logger.warn(
        `${LOG_TAG} the database ${name} is still open somewhere else; it will ` +
          'be deleted when that connection closes',
      );
      onBlocked(true);
      waiting = setTimeout(() => {
        settled = true;
        waiting = undefined;
        reject(new MatrixStoreEraseBlockedError([name], blockedTimeoutMs));
      }, blockedTimeoutMs);
    };
  });
}
