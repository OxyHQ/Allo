import { ephemeralRedactionsDue } from '@/lib/matrix/ephemeral/expiry';
import type {
  AlloEphemeralPolicy,
  AlloTimelineItem,
  AlloUnsubscribe,
} from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { ephemeralPolicies, type EphemeralPoliciesLike } from './ephemeralPolicies';
import { timelineSource } from './timelineSource';

/**
 * Taking this device's own expired messages off the homeserver.
 *
 * The half of an ephemeral conversation that is not a courtesy. Hiding a message
 * locally protects nothing a determined reader cannot get around; a redaction
 * removes the content from the homeserver, for everybody, and afterwards there
 * is no key that opens it because there is nothing left to open. That is the
 * whole reason this tier is built the way it is — see `docs/matrix/ephemeral.md`.
 *
 * ## Why it holds a timeline open for every ephemeral conversation
 *
 * Only the sender can redact their own message, so a message disappears from the
 * homeserver exactly when *its author's* client asks. If that only happened
 * while the conversation was on screen, the promise would hold for conversations
 * people keep looking at and quietly fail for the ones they stop opening — which
 * is the case the tier exists for. So this subscribes to `timelineSource` for
 * every ephemeral conversation and leaves it subscribed: the source's own expiry
 * timer wakes it at each deadline, and this acts on what it then reports.
 *
 * The cost is bounded by how many conversations the user has made ephemeral, and
 * that is a number they chose. An ordinary account has none and this holds
 * nothing open at all.
 *
 * ## What it still does not cover
 *
 * The app has to be running. Nothing redacts anything while Allo is closed, and
 * on a phone that is most of the day; a message expires *at or after* its
 * deadline, whenever the app is next awake. And it only sees the rows the
 * timeline is holding — a device that was away for longer than the conversation
 * is deep has messages further back than the live window, and they are redacted
 * the next time something paginates to them. Both are gaps 7 and 8 in
 * `docs/matrix/ephemeral.md`.
 */

/**
 * What this needs of a conversation's timeline.
 *
 * A shape rather than the class, for the same reason `MatrixRuntimeLike` exists:
 * `TimelineSource` has private fields, so a test could not otherwise stand one
 * in.
 */
export interface SweepableTimeline {
  subscribe(listener: () => void): AlloUnsubscribe;
  getSnapshot(): { readonly items: readonly AlloTimelineItem[] };
  redact(key: string, reason?: string): Promise<void>;
}

/** How this reaches a conversation. Injected so a test needs no runtime. */
export type SweepableTimelineFactory = (roomId: string) => SweepableTimeline;

export class EphemeralSweeper {
  readonly #policies: EphemeralPoliciesLike;
  readonly #openTimeline: SweepableTimelineFactory;
  readonly #listeners = new Set<() => void>();
  /** One entry per conversation being kept on a timer. */
  readonly #watched = new Map<string, WatchedRoom>();

  #roomIds: readonly string[] = [];
  #watchingPolicies: AlloUnsubscribe | undefined;

  constructor(policies: EphemeralPoliciesLike, openTimeline: SweepableTimelineFactory) {
    this.#policies = policies;
    this.#openTimeline = openTimeline;
  }

  /**
   * Watches the sweep, and starts it.
   *
   * Subscribing is what runs it, exactly as it is for `roomListSource.ts`: the
   * first thing that wants to know which conversations are on a timer is by
   * definition something that wants them to be. Nothing has to remember to
   * switch it on, and nothing switches it off — it stops when the account's
   * ephemeral conversations do.
   */
  readonly subscribe = (listener: () => void): AlloUnsubscribe => {
    this.#listeners.add(listener);
    if (this.#watchingPolicies === undefined) {
      this.#watchingPolicies = this.#policies.subscribe(this.#onPoliciesChanged);
      this.#onPoliciesChanged();
    }
    return () => {
      this.#listeners.delete(listener);
    };
  };

  /** The conversations this device is keeping on a timer, in a stable order. */
  readonly getSnapshot = (): readonly string[] => this.#roomIds;

  /** Releases every timeline. For tests, and for a torn-down app. */
  stop(): void {
    for (const watched of this.#watched.values()) {
      watched.release();
    }
    this.#watched.clear();
    this.#watchingPolicies?.();
    this.#watchingPolicies = undefined;
    this.#publish();
  }

  readonly #onPoliciesChanged = (): void => {
    const policies = this.#policies.getSnapshot();

    for (const [roomId, watched] of this.#watched) {
      const policy = policies.get(roomId);
      if (policy === undefined) {
        // The conversation stopped being ephemeral. What has already been
        // redacted stays redacted — a redaction cannot be undone — but nothing
        // more is taken away.
        watched.release();
        this.#watched.delete(roomId);
      } else {
        watched.policy = policy;
      }
    }

    for (const [roomId, policy] of policies) {
      if (!this.#watched.has(roomId)) {
        this.#watched.set(roomId, this.#watch(roomId, policy));
      }
    }

    this.#publish();
    // Every conversation is looked at once now rather than waiting for its
    // timeline to change: the messages that expired while the app was closed
    // are the ones this exists for, and nothing else is going to report them.
    for (const watched of this.#watched.values()) {
      watched.sweep();
    }
  };

  #watch(roomId: string, policy: AlloEphemeralPolicy): WatchedRoom {
    return new WatchedRoom(roomId, policy, this.#openTimeline(roomId));
  }

  #publish(): void {
    const roomIds = [...this.#watched.keys()].sort();
    if (
      roomIds.length === this.#roomIds.length &&
      roomIds.every((roomId, index) => roomId === this.#roomIds[index])
    ) {
      return;
    }
    this.#roomIds = roomIds;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** One conversation, held open and swept whenever its timeline moves. */
class WatchedRoom {
  policy: AlloEphemeralPolicy;

  readonly #roomId: string;
  readonly #timeline: SweepableTimeline;
  readonly #unsubscribe: AlloUnsubscribe;
  /**
   * Rows a redaction has already been asked for.
   *
   * Without it every wake-up would ask again for everything already expired: a
   * redacted row leaves its skeleton in the timeline, and the request is in
   * flight for as long as the homeserver takes. The set is per conversation and
   * dies with it.
   */
  readonly #asked = new Set<string>();

  #released = false;

  constructor(roomId: string, policy: AlloEphemeralPolicy, timeline: SweepableTimeline) {
    this.#roomId = roomId;
    this.policy = policy;
    this.#timeline = timeline;
    this.#unsubscribe = timeline.subscribe(() => {
      this.sweep();
    });
  }

  sweep(): void {
    if (this.#released) {
      return;
    }
    const snapshot = this.#timeline.getSnapshot();
    // The rows are the ones `timelineSource` publishes, which in an ephemeral
    // conversation are already aged: an expired row of the viewer's own is still
    // theirs, still has its event id and is still not redacted, which is exactly
    // what this asks for.
    for (const key of ephemeralRedactionsDue(snapshot.items, this.policy, Date.now())) {
      if (this.#asked.has(key)) {
        continue;
      }
      this.#asked.add(key);
      void this.#timeline.redact(key).catch((error: unknown) => {
        // Let a later wake-up try again. A message that stayed on the homeserver
        // because one request failed is the failure this whole tier is about.
        this.#asked.delete(key);
        logger.error(
          `[chat] an expired message in ${this.#roomId} could not be removed from ` +
            'the homeserver',
          error,
        );
      });
    }
  }

  release(): void {
    this.#released = true;
    this.#unsubscribe();
  }
}

/** The app's one sweep, over the app's conversations. */
export const ephemeralSweeper = new EphemeralSweeper(ephemeralPolicies, timelineSource);
