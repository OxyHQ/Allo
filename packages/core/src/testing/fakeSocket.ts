/**
 * A fake Socket.IO client bound to a {@link FakeAlloServer}: it verifies the
 * handshake the way the backend does, joins the instance and account rooms,
 * and reconnects on its own after a server-side drop, so an "offline" test
 * exercises the client's reconnect path.
 */
import type { SocketAuthPayload, SocketLike } from "../types";

export interface SocketHost {
  acceptSocket(auth: SocketAuthPayload): { instanceId: string; accountId: string } | { error: string };
  attach(socket: FakeSocket, instanceId: string, accountId: string): void;
  detach(socket: FakeSocket): void;
  onClientEvent(socket: FakeSocket, event: string, payload: unknown): void;
}

const RECONNECT_MS = 25;

export class FakeSocket implements SocketLike {
  connected = false;
  instanceId: string | null = null;
  accountId: string | null = null;
  private handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  private wantConnected = false;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private connecting = false;

  constructor(
    private readonly host: SocketHost,
    private readonly auth: () => Promise<SocketAuthPayload>,
  ) {}

  connect(): void {
    this.wantConnected = true;
    void this.tryConnect();
  }

  private async tryConnect(): Promise<void> {
    if (!this.wantConnected || this.connected || this.connecting) return;
    this.connecting = true;
    try {
      const payload = await this.auth();
      const verdict = this.host.acceptSocket(payload);
      if ("error" in verdict) {
        this.fire("connect_error", new Error(verdict.error));
        this.scheduleRetry();
        return;
      }
      this.instanceId = verdict.instanceId;
      this.accountId = verdict.accountId;
      this.connected = true;
      this.host.attach(this, verdict.instanceId, verdict.accountId);
      this.fire("connect");
    } finally {
      this.connecting = false;
    }
  }

  private scheduleRetry(): void {
    if (this.retry || !this.wantConnected) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.tryConnect();
    }, RECONNECT_MS);
  }

  disconnect(): void {
    this.wantConnected = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    if (this.connected) {
      this.connected = false;
      this.host.detach(this);
      this.fire("disconnect", "io client disconnect");
    }
  }

  /** Server-side drop: the socket reconnects on its own. */
  dropFromServer(): void {
    if (!this.connected) return;
    this.connected = false;
    this.host.detach(this);
    this.fire("disconnect", "io server disconnect");
    this.scheduleRetry();
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler);
  }

  off(event: string, handler?: (...args: unknown[]) => void): void {
    if (!handler) this.handlers.delete(event);
    else this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, payload: unknown): void {
    if (!this.connected) return;
    this.host.onClientEvent(this, event, payload);
  }

  /** Server → client, delivered asynchronously like a real frame: once sent, a later disconnect does not unsend it. */
  receive(event: string, payload: unknown): void {
    if (!this.connected) return;
    setTimeout(() => this.fire(event, payload), 0);
  }

  private fire(event: string, ...args: unknown[]): void {
    for (const h of [...(this.handlers.get(event) ?? [])]) h(...args);
  }
}
