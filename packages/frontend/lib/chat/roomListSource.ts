import type { AlloRoomListHandle, AlloRoomSummary, AlloUnsubscribe } from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { matrixRuntime, type MatrixRuntimeLike } from './matrixRuntime';

/**
 * The conversation list, as something React can read without an Effect.
 *
 * The port hands its room list over as `rooms()` plus a `subscribe`-shaped
 * callback precisely so that this adapter can exist: `subscribe` and
 * {@link RoomListSource.getSnapshot} are exactly what `useSyncExternalStore`
 * asks for. What this class adds on top is the part the port leaves to its
 * caller — that the list can only be opened once sync is running, so opening has
 * to wait for the runtime and be given up if the runtime goes away.
 */

/**
 * The empty list, as one object.
 *
 * `useSyncExternalStore` compares snapshots by identity and throws if one keeps
 * changing, so "no rooms" has to be the same array every time it is answered.
 */
const NO_ROOMS: readonly AlloRoomSummary[] = [];

export class RoomListSource {
  readonly #runtime: MatrixRuntimeLike;
  readonly #listeners = new Set<() => void>();

  #rooms: readonly AlloRoomSummary[] = NO_ROOMS;
  #handle: AlloRoomListHandle | undefined;
  #watchingRuntime = false;
  /**
   * Distinguishes the list this source is currently showing from one an earlier,
   * superseded `observeRooms` is still resolving towards. Bumped whenever the
   * handle is dropped, which makes every callback and every pending open from
   * before that point a no-op.
   */
  #generation = 0;
  #opening = false;

  constructor(runtime: MatrixRuntimeLike) {
    this.#runtime = runtime;
  }

  /**
   * Watches the conversation list.
   *
   * Unsubscribing does not close the underlying room list. This source is the
   * app's one conversation list, the screen that draws it is mounted for
   * essentially the whole session, and on native every reopen costs a projection
   * of every room across the FFI boundary. What does close it is the runtime
   * leaving the `ready` phase, and the port's own `close()`, which releases every
   * handle it handed out.
   */
  readonly subscribe = (listener: () => void): AlloUnsubscribe => {
    this.#listeners.add(listener);
    if (!this.#watchingRuntime) {
      this.#watchingRuntime = true;
      this.#runtime.subscribe(this.#onRuntimeChanged);
      // The runtime notifies on change, so a runtime that was already ready when
      // the first subscriber arrived would otherwise never open anything.
      this.#onRuntimeChanged();
    }
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): readonly AlloRoomSummary[] => this.#rooms;

  readonly #onRuntimeChanged = (): void => {
    const ready = this.#runtime.getState().phase === 'ready';
    if (ready) {
      if (this.#handle === undefined && !this.#opening) {
        void this.#open();
      }
      return;
    }
    if (this.#handle !== undefined || this.#opening) {
      this.#drop();
    }
  };

  async #open(): Promise<void> {
    const generation = this.#generation;
    this.#opening = true;
    try {
      const handle = await this.#runtime
        .client('Observing the conversation list')
        .observeRooms((rooms) => {
          this.#publish(generation, rooms);
        });
      if (generation !== this.#generation) {
        // The runtime went away while this was opening. The handle is nobody's
        // and closing it is the only thing left to do with it.
        handle.close();
        return;
      }
      this.#handle = handle;
      // The web half publishes from inside `observeRooms`, before the promise
      // resolves; the native half publishes later. Reading the handle covers the
      // first case without assuming either.
      this.#publish(generation, handle.rooms());
    } catch (error) {
      logger.error('[chat] the Matrix conversation list could not be opened', error);
    } finally {
      if (generation === this.#generation) {
        this.#opening = false;
      }
    }
  }

  #drop(): void {
    this.#generation += 1;
    this.#opening = false;
    const handle = this.#handle;
    this.#handle = undefined;
    handle?.close();
    this.#rooms = NO_ROOMS;
    this.#emit();
  }

  #publish(generation: number, rooms: readonly AlloRoomSummary[]): void {
    if (generation !== this.#generation || rooms === this.#rooms) {
      return;
    }
    this.#rooms = rooms;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** The app's conversation list. */
export const roomListSource = new RoomListSource(matrixRuntime);
