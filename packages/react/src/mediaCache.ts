/**
 * A provider-level LRU of decrypted media bytes keyed by `MediaRef`, with
 * in-flight de-duplication so two components asking for the same blob at
 * once cause one download. Owned by `AlloProvider`; `useMediaFile` reads it.
 */
import type { MediaRef } from "@allo/core";

export const DEFAULT_MEDIA_CACHE_SIZE = 50;

export function mediaKey(ref: MediaRef): string {
  return `${ref.conversationId}/${ref.blobId}`;
}

export class MediaCache {
  private readonly entries = new Map<string, Uint8Array>();
  private readonly inFlight = new Map<string, Promise<Uint8Array>>();

  constructor(readonly capacity: number = DEFAULT_MEDIA_CACHE_SIZE) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error(`MediaCache capacity must be a positive integer, got ${capacity}`);
  }

  get size(): number {
    return this.entries.size;
  }

  /** Returns the cached bytes and marks the entry most recently used. */
  get(key: string): Uint8Array | undefined {
    const bytes = this.entries.get(key);
    if (!bytes) return undefined;
    this.entries.delete(key);
    this.entries.set(key, bytes);
    return bytes;
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  set(key: string, bytes: Uint8Array): void {
    this.entries.delete(key);
    this.entries.set(key, bytes);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** Cached bytes, or the single shared download for this key. A failed download is not remembered, so the next call retries. */
  load(key: string, download: () => Promise<Uint8Array>): Promise<Uint8Array> {
    const cached = this.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const promise = download().then(
      (bytes) => {
        this.inFlight.delete(key);
        this.set(key, bytes);
        return bytes;
      },
      (error: unknown) => {
        this.inFlight.delete(key);
        throw error;
      },
    );
    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}
