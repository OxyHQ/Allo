/**
 * PRESENCE, CLIENT SIDE — a watch set, a cache, and no memory.
 *
 * The screen says which accounts it is drawing (`watch`), the SDK asks the
 * server for those once, and the socket pushes changes for those. Nothing
 * here is persisted: presence is true for as long as it is true, and a dot
 * restored from disk on a cold start would be a claim this device cannot
 * make. The map lives for the life of the client, like typing's timers.
 *
 * What the server refuses to answer is not distinguishable here either. An
 * account that hides, one that blocked you, one you share no conversation
 * with and one that is simply offline all arrive as
 * `{ online: false, lastSeenAt: null }`, and this service does not try to be
 * cleverer than that.
 *
 * `publishing` is the one extra fact: whether THIS account publishes its own
 * presence, and therefore whether it may see anybody else's. The app shows
 * that as a reason rather than drawing everyone as offline.
 */
import { presenceResponseSchema, SERVER_TO_CLIENT_EVENTS, type PresenceState } from "@allo/shared-types";
import type { Context } from "../context";
import type { PresenceView } from "../types";
import { describeError } from "../util/logger";

/** The answer for an account nobody has said anything about yet. Frozen: a new object per read is a new snapshot per read. */
export const PRESENCE_UNKNOWN: PresenceView = Object.freeze({ online: false, lastSeenAt: null, known: false });

export class PresenceService {
  private readonly states = new Map<string, PresenceView>();
  private watching: string[] = [];
  private publishingOwn = true;
  private beat: ReturnType<typeof setInterval> | null = null;
  /**
   * Bumped on every change. A map is not a snapshot React can compare, and a
   * copy of it would be a new object per render; this number is what a hook
   * subscribes to, and `of()` is read after it changes.
   */
  private changes = 0;

  constructor(private readonly ctx: Context) {}

  /** The accounts this client is showing. Replaces the previous set; an empty one stops the updates. */
  async watch(accountIds: readonly string[]): Promise<void> {
    const next = [...new Set(accountIds)].filter((id) => id !== this.ctx.accountId);
    const same = next.length === this.watching.length && next.every((id, i) => id === this.watching[i]);
    if (same) return;
    this.watching = next;
    this.ctx.realtime.emitPresenceWatch(next);
    for (const id of [...this.states.keys()]) if (!next.includes(id)) this.states.delete(id);
    if (next.length === 0) {
      this.invalidate();
      return;
    }
    await this.refresh();
  }

  /**
   * The socket came back. The watch set and the heartbeat belong to the
   * socket that carried them, so both are re-sent, and the set is re-read:
   * whatever changed while the connection was gone was never pushed.
   */
  async resume(): Promise<void> {
    if (this.watching.length === 0) return;
    this.ctx.realtime.emitPresenceWatch(this.watching);
    this.ctx.realtime.emitPresenceHeartbeat();
    await this.refresh();
  }

  /** Ask for the whole watch set at once — what a screen needs to draw before anything changes. */
  async refresh(): Promise<void> {
    if (this.watching.length === 0) return;
    try {
      const answer = await this.ctx.http.request({
        method: "GET",
        path: `/v1/presence?accountIds=${this.watching.map(encodeURIComponent).join(",")}`,
        schema: presenceResponseSchema,
        signer: this.ctx.signer,
      });
      this.publishingOwn = answer.publishing;
      for (const state of answer.presence) this.remember(state);
      this.invalidate();
    } catch (error) {
      // Presence is decoration: a failed read leaves what is known alone.
      this.ctx.log.debug?.("presence refresh failed", { error: describeError(error) });
    }
  }

  /** One account changed, from the socket. */
  onPresence(payload: unknown): void {
    const parsed = SERVER_TO_CLIENT_EVENTS.presence.safeParse(payload);
    if (!parsed.success) return;
    if (!this.watching.includes(parsed.data.accountId)) return;
    this.remember(parsed.data);
    this.invalidate();
  }

  /**
   * Start telling the server this device is here, every
   * `PRESENCE_HEARTBEAT_MS`. A socket staying open is not presence — it
   * survives a sleeping phone — so the beat is what counts, and stopping it
   * is how an account goes offline.
   */
  start(intervalMs: number): void {
    if (this.beat) return;
    this.ctx.realtime.emitPresenceHeartbeat();
    this.beat = setInterval(() => this.ctx.realtime.emitPresenceHeartbeat(), intervalMs);
    this.beat.unref?.();
  }

  stop(): void {
    if (this.beat) clearInterval(this.beat);
    this.beat = null;
    this.states.clear();
    this.watching = [];
    this.changes += 1;
  }

  /** What the UI reads. Stable between changes, so `useSyncExternalStore` sees no churn. */
  of(accountId: string): PresenceView {
    return this.states.get(accountId) ?? PRESENCE_UNKNOWN;
  }

  /** Whether this account publishes its own presence, and so may see anybody's. */
  get publishing(): boolean {
    return this.publishingOwn;
  }

  /** How many times anything here has changed. What a UI subscribes to. */
  get version(): number {
    return this.changes;
  }

  private remember(state: PresenceState): void {
    const current = this.states.get(state.accountId);
    if (current && current.online === state.online && current.lastSeenAt === state.lastSeenAt) return;
    this.states.set(state.accountId, Object.freeze({ online: state.online, lastSeenAt: state.lastSeenAt, known: true }));
  }

  private invalidate(): void {
    this.changes += 1;
    this.ctx.emitter.emit("presence");
  }
}
