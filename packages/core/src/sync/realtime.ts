/**
 * The socket wiring: connects to `/v1` with a freshly signed handshake,
 * turns server events into SDK actions, and relays typing.
 */
import { SERVER_TO_CLIENT_EVENTS } from "@allo/shared-types";
import type { Context } from "../context";
import { buildSocketAuth, defaultSocketFactory, socketUrl } from "../transport/socket";
import type { SocketLike } from "../types";
import { describeError } from "../util/logger";

const STATUS_CHECK_MS = 5000;

export class Realtime {
  private socket: SocketLike | null = null;
  private lastStatusCheck = 0;

  constructor(private readonly ctx: Context) {}

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  connect(): void {
    const { ctx } = this;
    if (this.socket) return;
    const factory = ctx.options.transport?.socketFactory ?? defaultSocketFactory;
    const socket = factory(socketUrl(ctx.options.baseUrl), async () => {
      const token = (await ctx.options.session.getAccessToken()) ?? "";
      return buildSocketAuth({ token, instanceId: ctx.instanceId, key: ctx.signer.key, now: ctx.now() });
    });
    this.socket = socket;
    socket.on("connect", () => {
      ctx.sync.setState("live");
      ctx.sync.request();
      // The watch set and the heartbeat belong to the SOCKET, so a reconnect
      // starts both again. Without this a client that dropped for a second
      // stops hearing about the accounts it is drawing.
      void ctx.presence.resume();
    });
    socket.on("disconnect", () => {
      if (ctx.sync.state === "live") ctx.sync.setState("idle");
    });
    socket.on("connect_error", (error) => {
      ctx.log.debug?.("socket connect error", { error: describeError(error) });
      // A refused handshake may mean this instance was revoked or is still pending: re-read our status, throttled.
      const now = ctx.now();
      if (now - this.lastStatusCheck > STATUS_CHECK_MS) {
        this.lastStatusCheck = now;
        void ctx.instance.refresh().catch(() => undefined);
      }
    });
    socket.on("sync.nudge", (payload) => {
      const parsed = SERVER_TO_CLIENT_EVENTS["sync.nudge"].safeParse(payload);
      if (!parsed.success) return;
      // A nudge naming a conversation lets its elector re-check unreachable members at once (the throttle is skipped).
      if (parsed.data.conversationId) ctx.conversations.noteNudge(parsed.data.conversationId);
      ctx.sync.request();
    });
    socket.on("instance.approved", (payload) => {
      if (!SERVER_TO_CLIENT_EVENTS["instance.approved"].safeParse(payload).success) return;
      ctx.sync.instancesStale = true;
      void ctx.instance
        .refresh()
        .then(() => ctx.onInstanceActivated?.())
        .catch((error) => ctx.log.debug?.("refresh after approval failed", { error: describeError(error) }));
    });
    socket.on("instance.revoked", (payload) => {
      const parsed = SERVER_TO_CLIENT_EVENTS["instance.revoked"].safeParse(payload);
      if (!parsed.success) return;
      ctx.sync.instancesStale = true;
      if (parsed.data.instanceId === ctx.instanceId) ctx.instance.markRevoked();
      else void ctx.instance.refresh().catch(() => undefined);
    });
    socket.on("keypackages.low", (payload) => {
      const parsed = SERVER_TO_CLIENT_EVENTS["keypackages.low"].safeParse(payload);
      if (parsed.success) void ctx.instance.topUpKeyPackages(parsed.data.available).catch((error) => ctx.log.debug?.("top-up failed", { error: describeError(error) }));
    });
    socket.on("history.offer", (payload) => {
      if (SERVER_TO_CLIENT_EVENTS["history.offer"].safeParse(payload).success) ctx.history.onOfferNudge();
    });
    socket.on("typing", (payload) => {
      const parsed = SERVER_TO_CLIENT_EVENTS.typing.safeParse(payload);
      if (parsed.success) void ctx.messages.onTyping(parsed.data.conversationId, parsed.data.ciphertext);
    });
    socket.on("presence", (payload) => {
      ctx.presence.onPresence(payload);
    });
    socket.on("status.posted", (payload) => {
      if (SERVER_TO_CLIENT_EVENTS["status.posted"].safeParse(payload).success) ctx.statuses.onPosted();
    });
    socket.connect();
  }

  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }

  emitTyping(conversationId: string, ciphertext: string): void {
    this.socket?.emit("typing", { conversationId, ciphertext });
  }

  /** The accounts this client is showing. The server answers for these and no others. */
  emitPresenceWatch(accountIds: readonly string[]): void {
    this.socket?.emit("presence.watch", { accountIds: [...accountIds] });
  }

  /** Still here. A socket that stays open through a sleeping phone is not presence. */
  emitPresenceHeartbeat(): void {
    this.socket?.emit("presence.heartbeat", {});
  }
}
