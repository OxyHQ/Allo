import type { AlloEphemeralPolicy, AlloUnsubscribe } from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { matrixRuntime, type MatrixRuntimeLike } from './matrixRuntime';

/**
 * Which conversations this account treats as ephemeral, as something React can
 * read without an Effect.
 *
 * The same shape as `roomListSource.ts` — `subscribe` plus `getSnapshot` — and
 * for the same reason: that is what `useSyncExternalStore` asks for, and the
 * answer belongs to the account rather than to whichever screen is drawing it.
 * Two screens read it (the conversation list draws its rows differently, the
 * administration screen sets it) and two things in `lib/chat/` act on it
 * (`timelineSource.ts` stops drawing expired messages, `ephemeralSweep.ts`
 * removes this device's own from the homeserver).
 *
 * **A snapshot, refreshed at named moments, and not a subscription.** The port
 * has no way to watch this: the native binding's `observeAccountDataEvent` takes
 * a closed enum of specified event types, and `so.oxy.allo.ephemeral_rooms` is
 * not one of them. So it is read when the session becomes usable and again after
 * this device changes it — which means a conversation the user makes ephemeral
 * on their phone is not drawn as one in a browser that is already open until the
 * browser reloads. That is gap 6 in `docs/matrix/ephemeral.md`, and it is a gap
 * in what is *drawn*: the guard inside the port reads the account data itself on
 * every send, so the rule is applied from the moment the homeserver has it.
 */

/**
 * The empty map, as one object.
 *
 * `useSyncExternalStore` compares snapshots by identity and throws if one keeps
 * changing, so "no ephemeral conversations" has to be the same map every time.
 */
const NONE: ReadonlyMap<string, AlloEphemeralPolicy> = new Map();

/** What a reader of the ephemeral conversations needs of them. */
export interface EphemeralPoliciesLike {
  subscribe(listener: () => void): AlloUnsubscribe;
  getSnapshot(): ReadonlyMap<string, AlloEphemeralPolicy>;
}

export class EphemeralPolicySource implements EphemeralPoliciesLike {
  readonly #runtime: MatrixRuntimeLike;
  readonly #listeners = new Set<() => void>();

  #policies: ReadonlyMap<string, AlloEphemeralPolicy> = NONE;
  #watchingRuntime = false;
  #loading: Promise<void> | undefined;
  /** See `roomListSource.ts`: invalidates a read from a session that has ended. */
  #generation = 0;

  constructor(runtime: MatrixRuntimeLike) {
    this.#runtime = runtime;
  }

  readonly subscribe = (listener: () => void): AlloUnsubscribe => {
    this.#listeners.add(listener);
    if (!this.#watchingRuntime) {
      this.#watchingRuntime = true;
      this.#runtime.subscribe(this.#onRuntimeChanged);
      // Subscribing is what reads it, so no screen has to remember to.
      this.#onRuntimeChanged();
    }
    return () => {
      this.#listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ReadonlyMap<string, AlloEphemeralPolicy> => this.#policies;

  /** The policy of one conversation, or `undefined` for an ordinary one. */
  policyFor(roomId: string): AlloEphemeralPolicy | undefined {
    return this.#policies.get(roomId);
  }

  /** Reads the account data again. Safe to call while a read is already running. */
  readonly refresh = (): Promise<void> => {
    if (this.#loading !== undefined) {
      return this.#loading;
    }
    const generation = this.#generation;
    const loading = this.#read(generation).finally(() => {
      if (this.#loading === loading) {
        this.#loading = undefined;
      }
    });
    this.#loading = loading;
    return loading;
  };

  /**
   * Makes a conversation ephemeral, changes its lifetime, or makes it ordinary
   * again with `undefined`.
   *
   * Not optimistic, for the reason `roomAdmin.ts` gives for every action on it:
   * a screen that showed "messages disappear after a day" while the homeserver
   * still had no such record would be promising something nothing is doing. The
   * write happens, then the account data is read back.
   */
  readonly setPolicy = async (
    roomId: string,
    policy: AlloEphemeralPolicy | undefined,
  ): Promise<void> => {
    await this.#runtime
      .client('Changing an ephemeral conversation')
      .setEphemeralPolicy(roomId, policy);
    // A read that is already running was started before the write and would
    // publish the state from before it.
    this.#loading = undefined;
    await this.refresh();
  };

  async #read(generation: number): Promise<void> {
    try {
      const policies = await this.#runtime
        .client('Reading the ephemeral conversations')
        .ephemeralPolicies();
      if (generation === this.#generation) {
        this.#publish(policies);
      }
    } catch (error) {
      // Reported and not thrown: every caller of this is a subscription or a
      // refresh nobody is waiting on, and an account whose ephemeral
      // conversations could not be read is drawn as an account with none —
      // which is what it looked like a moment ago anyway.
      logger.error('[chat] the ephemeral conversations could not be read', error);
    }
  }

  readonly #onRuntimeChanged = (): void => {
    if (this.#runtime.getState().phase === 'ready') {
      void this.refresh();
      return;
    }
    // The session went away. What was read belonged to it: keeping it would
    // put a timer on the conversations of an account nobody is signed in to.
    this.#generation += 1;
    this.#loading = undefined;
    this.#publish(NONE);
  };

  #publish(policies: ReadonlyMap<string, AlloEphemeralPolicy>): void {
    if (sameEphemeralPolicies(policies, this.#policies)) {
      return;
    }
    this.#policies = policies;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/**
 * Whether two readings of the account data say the same thing.
 *
 * Not an optimisation. Every read produces a new map, and publishing one on
 * every refresh would give `useSyncExternalStore` a new snapshot identity each
 * time — which re-renders the conversation list, and, through
 * `timelineSource.ts`, re-masks and re-schedules every open conversation.
 */
export function sameEphemeralPolicies(
  left: ReadonlyMap<string, AlloEphemeralPolicy>,
  right: ReadonlyMap<string, AlloEphemeralPolicy>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [roomId, policy] of left) {
    if (right.get(roomId)?.lifetimeMs !== policy.lifetimeMs) {
      return false;
    }
  }
  return true;
}

/** The app's one reading of them. */
export const ephemeralPolicies = new EphemeralPolicySource(matrixRuntime);
