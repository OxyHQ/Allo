import type { AlloMediaFile, AlloMediaRef, AlloUnsubscribe } from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { matrixRuntime, type MatrixRuntimeLike } from './matrixRuntime';

/**
 * Attachments that have been fetched, as something React can read without an
 * Effect.
 *
 * The problem this solves is a mismatch that cannot be fixed on the other side.
 * `MediaCarousel` asks for a URL **synchronously**, during render, from
 * `getMediaUrl(id)` — and getting one is a download and, in an encrypted room, a
 * decryption. So the answer has to come from a cache, and the cache has to tell
 * React when it has changed. That is `useSyncExternalStore`, which is the same
 * shape `roomListSource.ts` and `timelineSource.ts` already have.
 *
 * **Asking for a URL is what starts the download.** {@link MatrixMediaCache.url}
 * is called during render and, on a miss, schedules a fetch and answers
 * `undefined`; the row draws nothing, the fetch finishes, the store notifies,
 * and the row draws the picture. Kicking it off from a component Effect instead
 * would mean an Effect per visible attachment whose only job is to ask for
 * something the render already knows it needs. The read is idempotent and
 * deduplicated — a second call for a ref already in flight adds nothing — which
 * is what makes it safe to do from render.
 *
 * Bounded, and the bound is not an optimisation: every entry is a decrypted copy
 * of a picture from an encrypted conversation, sitting in the browser's memory
 * or in the phone's cache directory. Evicting one releases it.
 */

/** How many fetched attachments are kept before the oldest is released. */
const CAPACITY = 60;

/** Nothing fetched. One object, because `useSyncExternalStore` compares by identity. */
const NOTHING: ReadonlyMap<AlloMediaRef, string> = new Map();

export class MatrixMediaCache {
  readonly #runtime: MatrixRuntimeLike;
  readonly #listeners = new Set<() => void>();
  /** Insertion-ordered, which is what makes the oldest entry the first one. */
  readonly #files = new Map<AlloMediaRef, AlloMediaFile>();
  readonly #inFlight = new Set<AlloMediaRef>();
  /** Refs that failed. Kept so a broken attachment is not retried on every frame. */
  readonly #failed = new Set<AlloMediaRef>();

  #snapshot: ReadonlyMap<AlloMediaRef, string> = NOTHING;
  #watchingRuntime: AlloUnsubscribe | undefined;
  #userId: string | undefined;

  constructor(runtime: MatrixRuntimeLike) {
    this.#runtime = runtime;
  }

  readonly subscribe = (listener: () => void): AlloUnsubscribe => {
    this.#listeners.add(listener);
    if (this.#watchingRuntime === undefined) {
      this.#watchingRuntime = this.#runtime.subscribe(this.#onRuntimeChanged);
      // Read once on the way in as well as on every change. The runtime only
      // notifies on change, so without this the cache would never learn *which*
      // account it is holding pictures for — and a sign-out, which reports a
      // user id of `undefined`, would look identical to the state it started in
      // and clear nothing.
      this.#onRuntimeChanged();
    }
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ReadonlyMap<AlloMediaRef, string> => this.#snapshot;

  /**
   * The local URI for an attachment, or `undefined` while there is not one yet.
   *
   * Safe to call on every render of every row. See the note at the top of this
   * file for why a read starts a download.
   */
  readonly url = (ref: AlloMediaRef): string | undefined => {
    const ready = this.#snapshot.get(ref);
    if (ready !== undefined) {
      return ready;
    }
    if (!this.#inFlight.has(ref) && !this.#failed.has(ref)) {
      this.#inFlight.add(ref);
      void this.#fetch(ref);
    }
    return undefined;
  };

  /**
   * Releases everything fetched so far.
   *
   * Exposed for the runtime's sake — a session ending has to take the decrypted
   * copies with it — and used by tests.
   */
  readonly clear = (): void => {
    for (const file of this.#files.values()) {
      release(file);
    }
    this.#files.clear();
    this.#inFlight.clear();
    this.#failed.clear();
    if (this.#snapshot !== NOTHING) {
      this.#snapshot = NOTHING;
      this.#emit();
    }
  };

  async #fetch(ref: AlloMediaRef): Promise<void> {
    try {
      const file = await this.#runtime
        .client('Downloading an attachment')
        .downloadMedia(ref);
      if (!this.#inFlight.delete(ref)) {
        // The session ended while this was in flight, so nothing is waiting for
        // it and the bytes belong to a client that is gone.
        release(file);
        return;
      }
      this.#files.set(ref, file);
      this.#evictOldest();
      this.#publish();
    } catch (error) {
      this.#inFlight.delete(ref);
      // Remembered as failed rather than retried. The read that would retry it
      // happens on every render, and a homeserver that refused once will refuse
      // sixty times a second just as readily.
      this.#failed.add(ref);
      logger.error('[chat] an attachment could not be downloaded', error);
    }
  }

  #evictOldest(): void {
    while (this.#files.size > CAPACITY) {
      const oldest = this.#files.keys().next();
      if (oldest.done === true) {
        return;
      }
      const file = this.#files.get(oldest.value);
      this.#files.delete(oldest.value);
      if (file !== undefined) {
        release(file);
      }
      // Allowed to be fetched again: it is gone from the snapshot, so the next
      // render that wants it will ask, and asking is what starts a download.
      this.#failed.delete(oldest.value);
    }
  }

  readonly #onRuntimeChanged = (): void => {
    const { userId } = this.#runtime.getState();
    if (userId === this.#userId) {
      return;
    }
    // A different account — or none — is looking at this app now. Every URI in
    // here decrypts something the previous session was allowed to read.
    this.#userId = userId;
    this.clear();
  };

  #publish(): void {
    const next = new Map<AlloMediaRef, string>();
    for (const [ref, file] of this.#files) {
      next.set(ref, file.uri);
    }
    this.#snapshot = next;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/**
 * Lets go of a fetched attachment.
 *
 * Failures are logged and swallowed, and that is the right trade for once: a
 * temporary file that could not be deleted is a file the operating system will
 * reclaim, and throwing here would abort an eviction loop halfway and leak the
 * rest.
 */
function release(file: AlloMediaFile): void {
  try {
    file.release();
  } catch (error) {
    logger.warn('[chat] a downloaded attachment could not be released', error);
  }
}

/** The app's one attachment cache. */
export const mediaCache = new MatrixMediaCache(matrixRuntime);
