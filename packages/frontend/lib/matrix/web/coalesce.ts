/**
 * Collapsing a burst of SDK events into one rebuild.
 *
 * `matrix-js-sdk` reports changes, not state: one `/sync` response emits a
 * timeline event per message, a state event per room whose state moved, an
 * unread-count event per room, and so on. The port answers with whole arrays
 * instead — `AlloRoomListHandle.rooms()` and `AlloTimelineHandle.items()` are
 * snapshots — so rebuilding once per SDK event would rebuild the conversation
 * list dozens of times for one sync and hand the UI dozens of new arrays to
 * diff.
 *
 * A microtask is the shortest delay that still collapses a burst, and it costs no
 * timer: the UI never waits a frame for a message it could have shown.
 */
export class Coalescer {
  readonly #run: () => void;

  #scheduled = false;
  #cancelled = false;

  constructor(run: () => void) {
    this.#run = run;
  }

  /** Asks for one run, soon. Calling it again before that run does nothing. */
  schedule(): void {
    if (this.#scheduled || this.#cancelled) {
      return;
    }
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (!this.#cancelled) {
        this.#run();
      }
    });
  }

  /**
   * Drops any pending run, permanently.
   *
   * Permanently because the only caller is a handle being closed, and a rebuild
   * that lands after that would publish to an observer that has gone away.
   */
  cancel(): void {
    this.#cancelled = true;
  }
}
