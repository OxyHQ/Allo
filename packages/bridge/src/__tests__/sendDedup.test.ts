import { SendDeduplicator } from "../sendDedup";

/**
 * In-process send dedup: claim-once semantics, TTL expiry, release, clear, and the
 * defensive size bound. Deterministic via an injected `now` (no timers).
 */
describe("SendDeduplicator", () => {
  it("allows the first claim and blocks a duplicate within the TTL", () => {
    const dedup = new SendDeduplicator(1000, 100);
    const now = 10_000;
    expect(dedup.claim("m1", now)).toBe(true);
    // Same id again inside the TTL window is blocked.
    expect(dedup.claim("m1", now)).toBe(false);
    expect(dedup.claim("m1", now + 999)).toBe(false);
  });

  it("allows a re-claim once the TTL has elapsed", () => {
    const dedup = new SendDeduplicator(1000, 100);
    expect(dedup.claim("m1", 0)).toBe(true);
    expect(dedup.claim("m1", 999)).toBe(false); // still inside TTL
    // At/after the TTL boundary the id is swept and may be re-claimed.
    expect(dedup.claim("m1", 1000)).toBe(true);
  });

  it("isolates distinct message ids", () => {
    const dedup = new SendDeduplicator(1000, 100);
    expect(dedup.claim("a", 5)).toBe(true);
    expect(dedup.claim("b", 5)).toBe(true);
    expect(dedup.claim("a", 5)).toBe(false);
    expect(dedup.claim("b", 5)).toBe(false);
  });

  it("release() lets an id be claimed again immediately (for a legit retry)", () => {
    const dedup = new SendDeduplicator(1000, 100);
    expect(dedup.claim("m1", 100)).toBe(true);
    expect(dedup.claim("m1", 100)).toBe(false);
    dedup.release("m1");
    expect(dedup.claim("m1", 100)).toBe(true);
  });

  it("clear() drops all tracked ids", () => {
    const dedup = new SendDeduplicator(1000, 100);
    dedup.claim("a", 0);
    dedup.claim("b", 0);
    expect(dedup.size).toBe(2);
    dedup.clear();
    expect(dedup.size).toBe(0);
    expect(dedup.claim("a", 0)).toBe(true);
  });

  it("has() reflects live tracking and TTL expiry without claiming", () => {
    const dedup = new SendDeduplicator(1000, 100);
    expect(dedup.has("m1", 0)).toBe(false);
    dedup.claim("m1", 0);
    expect(dedup.has("m1", 500)).toBe(true);
    expect(dedup.has("m1", 1000)).toBe(false);
  });

  it("enforces the max-entries bound by evicting the oldest", () => {
    // Tiny cap so we can observe eviction; long TTL so nothing expires.
    const dedup = new SendDeduplicator(1_000_000, 3);
    dedup.claim("a", 1);
    dedup.claim("b", 2);
    dedup.claim("c", 3);
    expect(dedup.size).toBe(3);
    // Fourth distinct id evicts the oldest ("a").
    dedup.claim("d", 4);
    expect(dedup.size).toBe(3);
    // "a" was evicted, so it can be claimed again; "d" is still tracked.
    expect(dedup.has("a", 4)).toBe(false);
    expect(dedup.has("d", 4)).toBe(true);
  });

  it("sweeps expired entries during claim so the map does not grow unbounded over time", () => {
    const dedup = new SendDeduplicator(100, 1000);
    dedup.claim("a", 0);
    dedup.claim("b", 10);
    expect(dedup.size).toBe(2);
    // A much later claim sweeps both expired entries before adding the new one.
    expect(dedup.claim("c", 10_000)).toBe(true);
    expect(dedup.size).toBe(1);
  });
});
