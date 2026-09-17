/**
 * Remembers the last `AlloError` the client reported while its instance was
 * not active, so `useInstanceState` can say why the device is stuck. Core has
 * no getter for this; it only emits. The record clears when the instance
 * becomes `active`.
 */
import { AlloError, type AlloClient } from "@allo/core";

export class InstanceErrorTracker {
  private last: AlloError | undefined;
  private readonly listeners = new Set<() => void>();
  private detach: (() => void) | null = null;

  constructor(private readonly client: AlloClient) {}

  /** Starts listening. Returns the teardown. Idempotent. */
  attach(): () => void {
    if (this.detach) return this.detach;
    const offError = this.client.onError((error) => {
      if (!(error instanceof AlloError)) return;
      if (this.client.instance.state() === "active") return;
      this.last = error;
      this.notify();
    });
    const offInstance = this.client.subscribe("instance", () => {
      if (this.client.instance.state() === "active" && this.last !== undefined) {
        this.last = undefined;
        this.notify();
      }
    });
    this.detach = () => {
      offError();
      offInstance();
      this.detach = null;
    };
    return this.detach;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  current(): AlloError | undefined {
    return this.last;
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}
