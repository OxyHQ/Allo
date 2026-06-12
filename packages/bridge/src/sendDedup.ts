import { SEND_DEDUP_TTL_MS, SEND_DEDUP_MAX_ENTRIES } from "./config";

/**
 * In-process deduplication of outbound `send` commands, keyed by `messageId`.
 *
 * `/commands` AWAITS the Telegram send so a FLOOD_WAIT can be mapped to the right
 * HTTP status. The backend, however, aborts that request after its own ~10s
 * timeout and its durable outbox RETRIES the same command — possibly while the
 * connector is still mid-send (e.g. a large media upload). The connector has no
 * persistent record of the external message id at that point, so a naive retry
 * would deliver the SAME message to Telegram twice.
 *
 * This guard remembers each `messageId` from the moment its send STARTS until
 * `SEND_DEDUP_TTL_MS` elapses. A duplicate arriving in that window is reported as
 * already-handled, so the caller acknowledges it WITHOUT re-sending — the original
 * attempt's `send_result` will arrive / has arrived and carries the real outcome.
 *
 * Implementation is a timestamp map swept lazily on access (NOT per-entry
 * `setTimeout`s): this is deterministic given an injected `now` (so it works under
 * Jest fake timers and real time alike) and leaves NO dangling timers to reconcile
 * at graceful shutdown. The map is bounded by `SEND_DEDUP_MAX_ENTRIES`; on
 * overflow the oldest entries are evicted (they are long past being useful retry
 * windows).
 */
export class SendDeduplicator {
  /** messageId -> epoch ms when the send was first started. */
  private readonly started = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = SEND_DEDUP_TTL_MS,
    private readonly maxEntries: number = SEND_DEDUP_MAX_ENTRIES
  ) {}

  /**
   * Claim `messageId` for sending. Returns true when the caller MAY proceed with
   * the send (it is now recorded as in-flight); returns false when the id is
   * already in-flight or completed within the TTL — the caller must NOT re-send.
   *
   * Sweeps expired entries first so a retry after the TTL is correctly allowed.
   */
  claim(messageId: string, now: number = Date.now()): boolean {
    this.sweep(now);

    const startedAt = this.started.get(messageId);
    if (startedAt !== undefined && now - startedAt < this.ttlMs) {
      return false;
    }

    // Defensive bound: if we are at capacity with all-live entries, evict the
    // oldest so a single owner/bug can't grow the map without limit.
    if (this.started.size >= this.maxEntries && !this.started.has(messageId)) {
      this.evictOldest();
    }

    this.started.set(messageId, now);
    return true;
  }

  /**
   * Whether `messageId` is currently being tracked (in-flight or within TTL).
   * Exposed for tests/observability; not required by the send path.
   */
  has(messageId: string, now: number = Date.now()): boolean {
    const startedAt = this.started.get(messageId);
    return startedAt !== undefined && now - startedAt < this.ttlMs;
  }

  /** Drop a single tracked id (e.g. to allow an immediate, intentional re-send). */
  release(messageId: string): void {
    this.started.delete(messageId);
  }

  /** Clear ALL tracked ids (graceful shutdown / test reset). */
  clear(): void {
    this.started.clear();
  }

  /** Number of currently-tracked ids (after no sweep). Test/observability aid. */
  get size(): number {
    return this.started.size;
  }

  /** Remove entries whose TTL has elapsed relative to `now`. */
  private sweep(now: number): void {
    for (const [id, startedAt] of this.started) {
      if (now - startedAt >= this.ttlMs) {
        this.started.delete(id);
      }
    }
  }

  /** Evict the single oldest entry (Map preserves insertion order). */
  private evictOldest(): void {
    const oldest = this.started.keys().next();
    if (!oldest.done) {
      this.started.delete(oldest.value);
    }
  }
}

/** Process-wide deduplicator shared by the outbound command path. */
export const sendDeduplicator = new SendDeduplicator();
