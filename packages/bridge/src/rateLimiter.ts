import { OUTBOUND_SENDS_PER_WINDOW, OUTBOUND_SEND_WINDOW_MS } from "./config";

/**
 * Per-account sliding-window rate limiter for OUTBOUND sends.
 *
 * Telegram bans accounts that send faster than a human plausibly would, so the
 * connector paces sends per linked account. When an account exceeds
 * `OUTBOUND_SENDS_PER_WINDOW` within `OUTBOUND_SEND_WINDOW_MS`, the `/commands`
 * route returns 429 to Allo; Allo's durable outbox then retries with backoff, so
 * the message is delayed but never dropped. Anti-spam == anti-ban.
 *
 * Pure in-memory sliding window (timestamps per account, pruned on each check).
 * Deterministic given an injected `now`, so it is unit-testable without timers.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number = OUTBOUND_SENDS_PER_WINDOW,
    private readonly windowMs: number = OUTBOUND_SEND_WINDOW_MS
  ) {}

  /**
   * Record a send for `key` and report whether it is allowed. When allowed, the
   * timestamp is recorded; when denied (cap reached), nothing is recorded so the
   * caller can retry later without consuming a slot.
   */
  tryConsume(key: string, now: number = Date.now()): boolean {
    const windowStart = now - this.windowMs;
    const existing = this.hits.get(key) ?? [];
    const recent = existing.filter((ts) => ts > windowStart);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  /** Drop all recorded hits for a key (e.g. on unlink). */
  reset(key: string): void {
    this.hits.delete(key);
  }
}

/** Process-wide limiter shared by the outbound command path. */
export const outboundRateLimiter = new RateLimiter();
