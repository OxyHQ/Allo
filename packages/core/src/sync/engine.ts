/**
 * The pull loop. `GET /v1/sync` from the persisted cursor until `hasMore`
 * is false; every delivery goes through the {@link Dispatcher}, which
 * persists the cursor in the same batch as its effects; each page is acked
 * once processed. Triggers: a socket `sync.nudge`, a reconnect, an interval
 * while live, and `client.sync.now()`. Gap detection compares each
 * delivery's `seq` with the conversation's `lastSeq` and fills from
 * `/v1/conversations/:id/events?after=`. Queued (future-epoch) events are
 * replayed after every commit or join.
 */
import { listEventsResponseSchema, syncResponseSchema, type ConversationEvent } from "@allo/shared-types";
import type { Context } from "../context";
import { InstanceNotActiveError, TransportError } from "../errors";
import type { SyncState } from "../types";
import { describeError } from "../util/logger";
import { deferred } from "../util/async";
import { Dispatcher } from "./dispatch";

const PAGE = 200;

export class SyncEngine {
  private readonly dispatcher: Dispatcher;
  private stateValue: SyncState = "idle";
  private running: Promise<void> | null = null;
  private dirty = false;
  private waiters: Array<{ resolve: () => void; reject: (e: unknown) => void }> = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private lastInstanceRefresh = 0;
  instancesStale = true;

  constructor(private readonly ctx: Context) {
    this.dispatcher = new Dispatcher(ctx);
  }

  get state(): SyncState {
    return this.stateValue;
  }

  start(): void {
    this.stopped = false;
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => this.request(), this.ctx.options.syncIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
  }

  /** Schedules a sync soon; coalesces bursts of nudges. */
  request(): void {
    if (this.stopped) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = setTimeout(() => {
      this.scheduled = null;
      void this.now().catch(() => undefined);
    }, 0);
  }

  /** Runs a sync to completion (including one more pass if something arrived meanwhile). */
  now(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const d = deferred<void>();
    this.waiters.push(d);
    if (this.running) this.dirty = true;
    else this.running = this.loop();
    return d.promise;
  }

  private async loop(): Promise<void> {
    let failure: unknown;
    try {
      do {
        this.dirty = false;
        await this.runOnce();
      } while (this.dirty && !this.stopped);
    } catch (error) {
      failure = error;
      this.setState(error instanceof TransportError && error.isNetwork ? "offline" : "error");
      this.ctx.log.warn?.("sync failed", { error: describeError(error) });
      if (!(error instanceof InstanceNotActiveError)) this.ctx.emitter.emitError(error);
    } finally {
      this.running = null;
      const waiters = this.waiters.splice(0);
      for (const w of waiters) failure ? w.reject(failure) : w.resolve();
    }
  }

  private async runOnce(): Promise<void> {
    const { ctx } = this;
    if (!ctx.instance.isActive) {
      this.setState("idle");
      return;
    }
    this.setState("syncing");
    for (;;) {
      const page = await ctx.http.request({
        method: "GET",
        path: `/v1/sync?cursor=${encodeURIComponent(ctx.model.cursor)}&limit=${PAGE}`,
        schema: syncResponseSchema,
        signer: ctx.signer,
      });
      for (const delivery of page.deliveries) {
        await this.fillGap(delivery.event);
        const outcome = await this.dispatcher.dispatch(delivery.event, delivery.cursor);
        if (outcome.epochAdvanced) await this.replayQueued(delivery.conversationId);
      }
      if (page.deliveries.length > 0) {
        await ctx.http.request({ method: "POST", path: "/v1/sync/ack", body: { cursor: page.nextCursor }, signer: ctx.signer });
      }
      if (!page.hasMore) break;
    }
    await this.afterSync();
    this.setState(ctx.realtime?.connected ? "live" : "idle");
  }

  private async afterSync(): Promise<void> {
    const { ctx } = this;
    const age = ctx.now() - this.lastInstanceRefresh;
    if (this.instancesStale || age > ctx.options.syncIntervalMs) {
      try {
        await ctx.instance.refresh();
        this.instancesStale = false;
        this.lastInstanceRefresh = ctx.now();
      } catch (error) {
        ctx.log.debug?.("instance refresh failed", { error: describeError(error) });
      }
    }
    await ctx.conversations.reconcile();
    ctx.outbox.kick();
  }

  /** A delivery whose seq is ahead of what we saw: fetch what lies between (some of it is legitimately not ours). */
  private async fillGap(event: ConversationEvent): Promise<void> {
    const { ctx } = this;
    const conv = ctx.model.conversations.get(event.conversationId);
    if (!conv || !ctx.groups.has(event.conversationId) || conv.removed) return;
    if (event.seq <= conv.lastSeq + 1) return;
    let after = conv.lastSeq;
    for (;;) {
      const page = await ctx.http.request({
        method: "GET",
        path: `/v1/conversations/${event.conversationId}/events?after=${after}&limit=${PAGE}`,
        schema: listEventsResponseSchema,
        signer: ctx.signer,
      });
      for (const e of page.events) {
        if (e.seq >= event.seq) return;
        if (e.kind === "mls_welcome") continue; // not addressed to us, or we are already in
        const outcome = await this.dispatcher.dispatch(e, null);
        if (outcome.epochAdvanced) await this.replayQueued(e.conversationId);
        after = e.seq;
      }
      if (!page.hasMore || page.events.length === 0) return;
    }
  }

  /** Retries queued events of a conversation in seq order; a still-future one is re-queued by the dispatcher. */
  async replayQueued(conversationId: string): Promise<void> {
    const { ctx } = this;
    let progressed = true;
    while (progressed) {
      progressed = false;
      const queued = ctx.model.takeQueued(conversationId);
      if (queued.length === 0) return;
      for (const q of queued) {
        const outcome = await this.dispatcher.dispatch(q.event, null, true);
        if (!outcome.queued) progressed = true;
      }
    }
  }

  setState(state: SyncState): void {
    if (this.stateValue === state) return;
    this.stateValue = state;
    this.ctx.emitter.emit("sync");
  }
}
