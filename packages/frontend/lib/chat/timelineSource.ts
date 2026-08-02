import { MatrixEventNotSentError } from '@/lib/matrix/errors';
import type {
  AlloOutgoingAttachment,
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
  /** Matrix user ids of everyone else typing in this room, right now. */
  readonly typingUserIds: readonly string[];
}

const NO_ITEMS: readonly AlloTimelineItem[] = [];
const NOBODY_TYPING: readonly string[] = [];

const CLOSED: TimelineSnapshot = {
  items: NO_ITEMS,
  isOpening: false,
  isPaginating: false,
  reachedStart: false,
  typingUserIds: NOBODY_TYPING,
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
 * An operation named a row that is not in the timeline.
 *
 * The UI addresses messages by the key it draws them with, and a key that is no
 * longer there is ordinary rather than exceptional: a conversation can be reset
 * by a gappy sync between a long press and the tap that follows it.
 */
export class TimelineRowNotFoundError extends Error {
  constructor(operation: string, key: string, roomId: string) {
    super(
      `${operation} names the message ${key}, which is no longer in the timeline ` +
        `of ${roomId}.`,
    );
    this.name = 'TimelineRowNotFoundError';
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
  #watchingTyping: AlloUnsubscribe | undefined;
  /** The last event id a read receipt was sent for. See {@link markRead}. */
  #receipted: string | undefined;
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

  /**
   * Uploads an attachment and sends it.
   *
   * Nothing optimistic happens here either, and it matters more than it does
   * for text: an upload takes seconds, so the local echo the port puts in the
   * timeline is the only thing on screen while it runs, and a second row added
   * here would sit beside it for the whole upload.
   */
  readonly sendAttachment = async (attachment: AlloOutgoingAttachment): Promise<void> => {
    const handle = await this.#require('Sending an attachment');
    await handle.sendAttachment(attachment);
  };

  /** Adds the viewer's reaction to a row, or takes it away. */
  readonly toggleReaction = async (key: string, emoji: string): Promise<void> => {
    const handle = await this.#require('Reacting to a message');
    await handle.toggleReaction(this.#eventId('Reacting to a message', key), emoji);
  };

  /** Replaces the body of a row the viewer sent. */
  readonly edit = async (key: string, body: string): Promise<void> => {
    const handle = await this.#require('Editing a message');
    await handle.edit(this.#eventId('Editing a message', key), body);
  };

  /**
   * Removes a row's content.
   *
   * The row stays: a redaction leaves the event's skeleton standing and the
   * timeline reports it with a `redacted` content kind. Nothing is removed from
   * the snapshot here, and nothing should be — a row that vanished locally and
   * stayed everywhere else would be a lie that survives until the next sync.
   */
  readonly redact = async (key: string, reason?: string): Promise<void> => {
    const handle = await this.#require('Deleting a message');
    await handle.redact(this.#eventId('Deleting a message', key), reason);
  };

  /**
   * Tells the homeserver everything up to the newest row has been read.
   *
   * Safe to call on every render that might have changed the conversation: an
   * event already receipted is not sent again, and a timeline whose newest row is
   * still a local echo has nothing to receipt yet.
   */
  readonly markRead = async (): Promise<void> => {
    const newest = this.#newestRemoteEventId();
    if (newest === undefined || newest === this.#receipted) {
      return;
    }
    const handle = await this.#require('Sending a read receipt');
    // Recorded before the call rather than after it, so that a second render
    // arriving while this one is in flight does not send the same receipt twice.
    this.#receipted = newest;
    try {
      await handle.sendReadReceipt(newest);
    } catch (error) {
      // Let the next change try again: a receipt that never went out leaves the
      // sender's bubble one tick short for good.
      if (this.#receipted === newest) {
        this.#receipted = undefined;
      }
      throw error;
    }
  };

  /** Says whether the viewer is typing here. */
  readonly sendTypingNotice = async (isTyping: boolean): Promise<void> => {
    const handle = await this.#require('Sending a typing notice');
    await handle.sendTypingNotice(isTyping);
  };

  /**
   * The event id of a row, by the key the UI draws it with.
   *
   * Two ways to fail and they are different problems, so they are different
   * errors: the row is gone, or the row is there and is still on its way out.
   */
  #eventId(operation: string, key: string): string {
    const item = this.#snapshot.items.find((candidate) => candidate.key === key);
    if (item === undefined) {
      throw new TimelineRowNotFoundError(operation, key, this.#roomId);
    }
    if (item.id.kind !== 'remote') {
      throw new MatrixEventNotSentError(operation, key);
    }
    return item.id.eventId;
  }

  /**
   * The newest row the homeserver has accepted, if there is one.
   *
   * Searched from the end, because the rows this skips over — a message the user
   * has just sent and its neighbours — are the only ones that can be local.
   */
  #newestRemoteEventId(): string | undefined {
    const items = this.#snapshot.items;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const id = items[index].id;
      if (id.kind === 'remote') {
        return id.eventId;
      }
    }
    return undefined;
  }

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
        this.#watchingTyping = handle.observeTyping((typingUserIds) => {
          if (generation === this.#generation) {
            this.#publish({ typingUserIds });
          }
        });
        this.#publish({ isOpening: false });
        this.#publishItems(generation, handle.items());
        return handle;
      })
      .catch((error: unknown) => {
        // A timeline that could not be opened must not stay "opening" forever.
        // The ordinary way here is a room the homeserver has and this client has
        // not been told about yet — a conversation created a second ago, a deep
        // link into an invitation — and leaving the attempt in flight would keep
        // the screen on a spinner for the rest of the session *and* stop the
        // next attempt, because a pending open is what suppresses it. Reporting
        // "not open" lets a later runtime change, or a remount, try again.
        //
        // Only when this attempt is still the current one: an abandoned open
        // has already been superseded, and its state belongs to whoever
        // superseded it.
        if (generation === this.#generation) {
          this.#opening = undefined;
          this.#publish({ isOpening: false });
        }
        throw error;
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
    this.#watchingTyping?.();
    this.#watchingTyping = undefined;
    // The receipt belongs to the handle that sent it. A session that came back
    // has to be free to say again what it said before it went away.
    this.#receipted = undefined;
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
      next.reachedStart === this.#snapshot.reachedStart &&
      next.typingUserIds === this.#snapshot.typingUserIds
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
