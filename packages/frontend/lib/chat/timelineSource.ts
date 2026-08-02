import type {
  AlloPaginationOutcome,
  AlloTimelineHandle,
  AlloTimelineItem,
  AlloUnsubscribe,
} from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { matrixRuntime, type MatrixRuntimeLike } from './matrixRuntime';

/**
 * One conversation's timeline, as something React can read without an Effect.
 *
 * The counterpart of `roomListSource.ts`, with one difference that decides the
 * shape: a timeline is per room and there can be many rooms, so unlike the
 * conversation list this one really is closed when the last reader goes away.
 * Leaving every visited conversation subscribed would keep a listener per room
 * for the life of the app.
 *
 * Paginating and sending live here rather than in the hook because both are
 * timeline operations in the port — the Rust binding has no send method on
 * `Room` — and because whether a pagination is already running, and whether the
 * start of the conversation has been reached, are facts about the timeline and
 * not about whichever component is drawing it.
 */

export interface TimelineSnapshot {
  /** The rows, oldest first. */
  readonly items: readonly AlloTimelineItem[];
  /** The timeline has not been opened yet: there is nothing to draw *yet*. */
  readonly isOpening: boolean;
  readonly isPaginating: boolean;
  /** There are no older events to ask for. */
  readonly reachedStart: boolean;
}

const NO_ITEMS: readonly AlloTimelineItem[] = [];

const CLOSED: TimelineSnapshot = {
  items: NO_ITEMS,
  isOpening: false,
  isPaginating: false,
  reachedStart: false,
};

const OPENING: TimelineSnapshot = { ...CLOSED, isOpening: true };

/** A timeline operation was asked for on a conversation nothing is watching. */
export class TimelineNotOpenError extends Error {
  constructor(operation: string, roomId: string) {
    super(
      `${operation} needs the timeline of ${roomId} to be open, and nothing is ` +
        'watching it.',
    );
    this.name = 'TimelineNotOpenError';
  }
}

/**
 * A timeline finished opening into a session that had already ended.
 *
 * Ordinary rather than exceptional — signing out, or losing the session, while a
 * conversation is being opened — and worth its own type so it is not read as the
 * homeserver having refused anything.
 */
export class TimelineAbandonedError extends Error {
  constructor(roomId: string) {
    super(
      `The timeline of ${roomId} finished opening after its session ended, so it ` +
        'was closed instead of shown.',
    );
    this.name = 'TimelineAbandonedError';
  }
}

export class TimelineSource {
  readonly #runtime: MatrixRuntimeLike;
  readonly #roomId: string;
  readonly #listeners = new Set<() => void>();
  readonly #onIdle: () => void;

  #snapshot: TimelineSnapshot = CLOSED;
  #handle: AlloTimelineHandle | undefined;
  #opening: Promise<AlloTimelineHandle> | undefined;
  #watchingRuntime: AlloUnsubscribe | undefined;
  /** See `roomListSource.ts`: invalidates callbacks from a superseded handle. */
  #generation = 0;

  constructor(runtime: MatrixRuntimeLike, roomId: string, onIdle: () => void) {
    this.#runtime = runtime;
    this.#roomId = roomId;
    this.#onIdle = onIdle;
  }

  readonly subscribe = (listener: () => void): AlloUnsubscribe => {
    this.#listeners.add(listener);
    if (this.#watchingRuntime === undefined) {
      this.#watchingRuntime = this.#runtime.subscribe(this.#onRuntimeChanged);
      this.#onRuntimeChanged();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#close();
      }
    };
  };

  readonly getSnapshot = (): TimelineSnapshot => this.#snapshot;

  /**
   * Asks for older events.
   *
   * A second call while one is running, or any call once the start has been
   * reached, is answered from what is already known rather than sent to the
   * homeserver: a list that fires its "load more" handler on every frame near the
   * top would otherwise paginate the whole conversation.
   */
  readonly paginateBackwards = async (count: number): Promise<AlloPaginationOutcome> => {
    if (this.#snapshot.reachedStart) {
      return 'reached-start';
    }
    if (this.#snapshot.isPaginating) {
      return 'more-available';
    }
    const handle = await this.#require('Loading older messages');
    const generation = this.#generation;
    this.#publish({ isPaginating: true });
    try {
      const outcome = await handle.paginateBackwards(count);
      if (generation === this.#generation) {
        this.#publish({ isPaginating: false, reachedStart: outcome === 'reached-start' });
      }
      return outcome;
    } catch (error) {
      if (generation === this.#generation) {
        this.#publish({ isPaginating: false });
      }
      throw error;
    }
  };

  /**
   * Sends plain text.
   *
   * Nothing is done here about the local echo: the port puts the sent message in
   * the timeline itself, with `sendState: 'pending'`, and the row becomes the real
   * event when the homeserver acknowledges it. An optimistic entry added on top of
   * that would be a duplicate.
   */
  readonly sendText = async (body: string): Promise<void> => {
    const handle = await this.#require('Sending a message');
    await handle.sendText(body);
  };

  readonly #onRuntimeChanged = (): void => {
    if (this.#runtime.getState().phase === 'ready') {
      if (this.#handle === undefined && this.#opening === undefined) {
        void this.#open().catch((error: unknown) => {
          if (error instanceof TimelineAbandonedError) {
            // Not a failure: the session ended while the room was opening, and
            // the handle has already been closed.
            logger.info(`[chat] ${error.message}`);
            return;
          }
          logger.error(
            `[chat] the timeline of ${this.#roomId} could not be opened`,
            error,
          );
        });
      }
      return;
    }
    if (this.#handle !== undefined || this.#opening !== undefined) {
      this.#drop();
    }
  };

  #open(): Promise<AlloTimelineHandle> {
    const generation = this.#generation;
    this.#publish(OPENING);
    const opening = this.#runtime
      .client('Opening a conversation')
      .openTimeline(this.#roomId, (items) => {
        this.#publishItems(generation, items);
      })
      .then((handle) => {
        if (generation !== this.#generation) {
          handle.close();
          throw new TimelineAbandonedError(this.#roomId);
        }
        this.#handle = handle;
        this.#opening = undefined;
        this.#publish({ isOpening: false });
        this.#publishItems(generation, handle.items());
        return handle;
      });
    this.#opening = opening;
    return opening;
  }

  async #require(operation: string): Promise<AlloTimelineHandle> {
    const handle = this.#handle ?? (await this.#opening);
    if (handle === undefined) {
      throw new TimelineNotOpenError(operation, this.#roomId);
    }
    return handle;
  }

  #drop(): void {
    this.#generation += 1;
    this.#opening = undefined;
    const handle = this.#handle;
    this.#handle = undefined;
    handle?.close();
    this.#snapshot = CLOSED;
    this.#emit();
  }

  #close(): void {
    this.#drop();
    this.#watchingRuntime?.();
    this.#watchingRuntime = undefined;
    this.#onIdle();
  }

  #publishItems(generation: number, items: readonly AlloTimelineItem[]): void {
    if (generation !== this.#generation || items === this.#snapshot.items) {
      return;
    }
    this.#snapshot = { ...this.#snapshot, items };
    this.#emit();
  }

  #publish(patch: Partial<TimelineSnapshot>): void {
    const next: TimelineSnapshot = { ...this.#snapshot, ...patch };
    if (
      next.items === this.#snapshot.items &&
      next.isOpening === this.#snapshot.isOpening &&
      next.isPaginating === this.#snapshot.isPaginating &&
      next.reachedStart === this.#snapshot.reachedStart
    ) {
      return;
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
 * The open timelines, one per room.
 *
 * A registry and not a fresh source per component, because two components
 * drawing the same conversation — the list pane and the detail pane of the
 * three-panel layout — must not open two timelines over one room.
 */
const sources = new Map<string, TimelineSource>();

export function timelineSource(roomId: string): TimelineSource {
  const existing = sources.get(roomId);
  if (existing !== undefined) {
    return existing;
  }
  const source = new TimelineSource(matrixRuntime, roomId, () => {
    // Removed only if it is still the registered one: a component that
    // resubscribed in the same tick has already put a new source here.
    if (sources.get(roomId) === source) {
      sources.delete(roomId);
    }
  });
  sources.set(roomId, source);
  return source;
}
