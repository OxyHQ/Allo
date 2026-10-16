/**
 * THE WATCH SETS — who is being shown what, and when they are told.
 *
 * Presence used to be a broadcast: connect, and every account sharing any
 * conversation with you was told. For an account in fifty conversations that
 * is fifty notifications for one event, most of them to screens showing
 * nothing of the sort, and it is also the shape that makes an online dot
 * cheap to scrape. So a client now says what it is SHOWING
 * (`presence.watch`), and hears about exactly that.
 *
 * Three things drive an update:
 *
 * - **The watch itself.** A new set is answered in full, at once, so a screen
 *   draws correctly without waiting for anything to change.
 * - **A connection on this task.** A socket opening or closing here is pushed
 *   immediately to the watchers on this task. Watchers on other tasks learn on
 *   the next tick; presence is a dot, not a receipt, and a few seconds of skew
 *   costs nothing.
 * - **The tick.** Every `PRESENCE_TICK_MS` the union of every watch set on
 *   this task is read from the store in one round trip, and each watcher is
 *   sent only what CHANGED for it. This is also what turns a heartbeat's
 *   deadline passing into an offline dot: nothing reports that, it is
 *   discovered.
 *
 * Every read checks live central session/contact authority. Only the last
 * emitted value is retained to avoid sending unchanged dots, never permission.
 */

import {
  MAX_PRESENCE_WATCH,
  presenceWatchEventSchema,
  type PresenceState,
} from '@allo/shared-types';
import type { MessagingRequester } from '../services/platform/messagingPolicy';
import type { AuthenticatedInstance } from '../middleware/instanceAuth';
import { beat, farewell, readPresenceBatch } from '../services/platform/presenceService';
import { logger } from '../utils/logger';

/** How often the union of the watch sets is re-read. */
export const PRESENCE_TICK_MS = 15_000;

/** What the hub needs of a socket. Narrow on purpose: the tests drive it with a plain object. */
export interface PresenceSocket {
  readonly id: string;
  emit(event: 'presence', payload: PresenceState): unknown;
  disconnect(close?: boolean): unknown;
}

interface Watcher {
  socket: PresenceSocket;
  accountId: string;
  instanceId: string;
  watching: string[];
  requester: MessagingRequester;
  /** What this watcher was last told, so a tick sends only differences. */
  last: Map<string, string>;
}

const fingerprint = (state: PresenceState): string =>
  `${state.online ? '1' : '0'}:${state.lastSeenAt ?? ''}`;

export interface PresenceHubDeps {
  now?: () => Date;
  /** Injected by the tests; production uses the module defaults. */
  service?: {
    readPresenceBatch: typeof readPresenceBatch;
    beat: typeof beat;
    farewell: typeof farewell;
  };
}

export class PresenceHub {
  private readonly watchers = new Map<string, Watcher>();
  /** How many sockets each instance holds, so one of two closing is not a goodbye. */
  private readonly sockets = new Map<string, number>();
  /** Per account, when last seen was last written — passed to the service so it can throttle. */
  private readonly lastWrite = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: PresenceHubDeps = {}) {}

  private get service() {
    return this.deps.service ?? { readPresenceBatch, beat, farewell };
  }

  private get now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** A socket arrived. An ACTIVE instance starts beating; a pending one is not present. */
  async attach(
    socket: PresenceSocket,
    instance: AuthenticatedInstance,
    accessToken: string,
  ): Promise<void> {
    this.watchers.set(socket.id, {
      socket,
      accountId: instance.accountId,
      instanceId: instance.id,
      watching: [],
      requester: { accountId: instance.accountId, accessToken },
      last: new Map(),
    });
    if (instance.status !== 'active') return;
    this.sockets.set(instance.id, (this.sockets.get(instance.id) ?? 0) + 1);
    await this.service.beat(instance.accountId, instance.id, {
      now: () => this.now,
      lastWrite: this.lastWrite,
    });
    await this.pushLocal(instance.accountId);
  }

  /** A socket went. The instance is only gone when its last socket is. */
  async detach(socket: PresenceSocket, instance: AuthenticatedInstance): Promise<void> {
    this.watchers.delete(socket.id);
    if (instance.status !== 'active') return;
    const remaining = (this.sockets.get(instance.id) ?? 1) - 1;
    if (remaining > 0) {
      this.sockets.set(instance.id, remaining);
      return;
    }
    this.sockets.delete(instance.id);
    await this.service.farewell(instance.accountId, instance.id, { now: () => this.now });
    await this.pushLocal(instance.accountId);
  }

  /** Still here. Moves the deadline; an account that stops beating goes offline on its own. */
  async heartbeat(instance: AuthenticatedInstance): Promise<void> {
    if (instance.status !== 'active') return;
    await this.service.beat(instance.accountId, instance.id, {
      now: () => this.now,
      lastWrite: this.lastWrite,
    });
  }

  /**
   * The accounts this client is showing. Replaces the previous set — an empty
   * list is how a client stops listening — and answers the new one in full.
   */
  async watch(socket: PresenceSocket, payload: unknown): Promise<void> {
    const parsed = presenceWatchEventSchema.safeParse(payload);
    if (!parsed.success) return; // a malformed frame is dropped, as typing's is
    const watcher = this.watchers.get(socket.id);
    if (!watcher) return;

    const accountIds = [...new Set(parsed.data.accountIds)]
      .filter((id) => id !== watcher.accountId)
      .slice(0, MAX_PRESENCE_WATCH);
    watcher.watching = accountIds;
    watcher.last.clear();
    if (accountIds.length === 0) return;

    await this.refresh([watcher], this.now);
  }

  async tick(): Promise<void> {
    await this.refresh(
      [...this.watchers.values()].filter((watcher) => watcher.watching.length > 0),
      this.now,
    );
  }

  private async pushLocal(accountId: string): Promise<void> {
    await this.refresh(
      [...this.watchers.values()].filter((watcher) => watcher.watching.includes(accountId)),
      this.now,
    );
  }

  private async refresh(watchers: Watcher[], now: Date): Promise<void> {
    if (!watchers.length) return;
    try {
      const answer = await this.service.readPresenceBatch(
        watchers.map((watcher) => ({
          requestId: watcher.socket.id,
          instanceId: watcher.instanceId,
          accountId: watcher.accountId,
          accessToken: watcher.requester.accessToken,
          accountIds: watcher.watching,
        })),
        { now: () => now },
      );
      for (const watcher of watchers) {
        const states = answer.get(watcher.socket.id);
        if (!states) {
          watcher.socket.disconnect(true);
          continue;
        }
        for (const state of states) {
          const mark = fingerprint(state);
          if (watcher.last.get(state.accountId) === mark) continue;
          watcher.last.set(state.accountId, mark);
          watcher.socket.emit('presence', state);
        }
      }
    } catch (error) {
      for (const watcher of watchers) watcher.socket.disconnect(true);
      throw error;
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => logger.debug('presence tick failed', error));
    }, PRESENCE_TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watchers.clear();
    this.sockets.clear();
    this.lastWrite.clear();
  }

  /** For the tests and for a health line: how many sockets are watching anything. */
  get watching(): number {
    return [...this.watchers.values()].filter((w) => w.watching.length > 0).length;
  }
}
