/**
 * A typed topic emitter shaped for `useSyncExternalStore`: subscribers get a
 * signal, the getters on the client return the snapshot. Snapshots are cached
 * by their owners and replaced only on change, so React sees stable
 * references between emissions.
 */
import type { SubscriptionTopic } from "../types";

export type Listener = () => void;

export class Emitter {
  private readonly listeners = new Map<string, Set<Listener>>();
  private errorListeners = new Set<(error: unknown) => void>();

  subscribe(topic: SubscriptionTopic, listener: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  onError(listener: (error: unknown) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  emit(topic: SubscriptionTopic): void {
    const set = this.listeners.get(topic);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l();
      } catch {
        /* a listener's failure is not the SDK's */
      }
    }
  }

  emitError(error: unknown): void {
    for (const l of [...this.errorListeners]) {
      try {
        l(error);
      } catch {
        /* ignore */
      }
    }
    this.emit("error");
  }

  clear(): void {
    this.listeners.clear();
    this.errorListeners.clear();
  }
}
