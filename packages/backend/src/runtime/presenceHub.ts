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
 * Who may see whom is `presenceService.visibleTo`, cached per watcher for
 * `VISIBILITY_TTL_MS`. The cache is short because a block has to take effect
 * while the person who made it is still looking at the screen.
 */

import {
  MAX_PRESENCE_WATCH,
  presenceWatchEventSchema,
  type PresenceState,
} from "@allo/shared-types";
import type { AuthenticatedInstance } from "../middleware/instanceAuth";
import { beat, farewell, readPresence, visibleTo } from "../services/platform/presenceService";
import { logger } from "../utils/logger";

/** How often the union of the watch sets is re-read. */
export const PRESENCE_TICK_MS = 15_000;
/** How long a watcher's "may I see this account" answer is reused. */
export const VISIBILITY_TTL_MS = 60_000;

/** What the hub needs of a socket. Narrow on purpose: the tests drive it with a plain object. */
export interface PresenceSocket {
  readonly id: string;
  emit(event: "presence", payload: PresenceState): unknown;
}

interface Watcher {
  socket: PresenceSocket;
  accountId: string;
  instanceId: string;
  watching: string[];
  visible: Set<string>;
  visibleAt: number;
  /** What this watcher was last told, so a tick sends only differences. */
  last: Map<string, string>;
}

const fingerprint = (state: PresenceState): string => `${state.online ? "1" : "0"}:${state.lastSeenAt ?? ""}`;

export interface PresenceHubDeps {
  now?: () => Date;
  /** Injected by the tests; production uses the module defaults. */
  service?: {
    readPresence: typeof readPresence;
    visibleTo: typeof visibleTo;
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
    return this.deps.service ?? { readPresence, visibleTo, beat, farewell };
  }

  private get now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** A socket arrived. An ACTIVE instance starts beating; a pending one is not present. */
  async attach(socket: PresenceSocket, instance: AuthenticatedInstance): Promise<void> {
    this.watchers.set(socket.id, {
      socket,
      accountId: instance.accountId,
      instanceId: instance.id,
      watching: [],
      visible: new Set(),
      visibleAt: 0,
      last: new Map(),
    });
    if (instance.status !== "active") return;
    this.sockets.set(instance.id, (this.sockets.get(instance.id) ?? 0) + 1);
    await this.service.beat(instance.accountId, instance.id, { now: () => this.now, lastWrite: this.lastWrite });
    await this.pushLocal(instance.accountId);
  }

  /** A socket went. The instance is only gone when its last socket is. */
  async detach(socket: PresenceSocket, instance: AuthenticatedInstance): Promise<void> {
    this.watchers.delete(socket.id);
    if (instance.status !== "active") return;
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
    if (instance.status !== "active") return;
    await this.service.beat(instance.accountId, instance.id, { now: () => this.now, lastWrite: this.lastWrite });
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

    const accountIds = [...new Set(parsed.data.accountIds)].filter((id) => id !== watcher.accountId).slice(0, MAX_PRESENCE_WATCH);
    watcher.watching = accountIds;
    watcher.last.clear();
    watcher.visibleAt = 0;
    if (accountIds.length === 0) return;

    const answer = await this.service.readPresence(watcher.accountId, accountIds, { now: () => this.now });
    for (const state of answer.presence) {
      watcher.last.set(state.accountId, fingerprint(state));
      watcher.socket.emit("presence", state);
    }
  }

  /** One pass over this task's watchers, sending each only what changed for it. */
  async tick(): Promise<void> {
    const watchers = [...this.watchers.values()].filter((w) => w.watching.length > 0);
    if (watchers.length === 0) return;
    const now = this.now;
    for (const watcher of watchers) {
      try {
        await this.refresh(watcher, now);
      } catch (error: unknown) {
        logger.debug("presence tick failed for a watcher", error);
      }
    }
  }

  /** A connection changed on THIS task: tell the watchers here without waiting for the tick. */
  private async pushLocal(accountId: string): Promise<void> {
    const now = this.now;
    for (const watcher of this.watchers.values()) {
      if (!watcher.watching.includes(accountId)) continue;
      try {
        await this.refresh(watcher, now);
      } catch (error: unknown) {
        logger.debug("presence push failed", error);
      }
    }
  }

  private async refresh(watcher: Watcher, now: Date): Promise<void> {
    if (now.getTime() - watcher.visibleAt > VISIBILITY_TTL_MS) {
      watcher.visible = await this.service.visibleTo(watcher.accountId, watcher.watching, { now: () => now });
      watcher.visibleAt = now.getTime();
    }
    const answer = await this.service.readPresence(watcher.accountId, watcher.watching, { now: () => now });
    for (const state of answer.presence) {
      const mark = fingerprint(state);
      if (watcher.last.get(state.accountId) === mark) continue;
      watcher.last.set(state.accountId, mark);
      watcher.socket.emit("presence", state);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch((error: unknown) => logger.debug("presence tick failed", error));
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
