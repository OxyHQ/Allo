import { RateLimiter } from "../rateLimiter";

/**
 * Per-account sliding-window outbound cap. Deterministic via an injected `now`.
 */
describe("rateLimiter — per-account outbound cap", () => {
  it("allows up to the limit within the window, then denies", () => {
    const limiter = new RateLimiter(3, 60_000);
    const now = 1_000_000;
    expect(limiter.tryConsume("acct", now)).toBe(true);
    expect(limiter.tryConsume("acct", now)).toBe(true);
    expect(limiter.tryConsume("acct", now)).toBe(true);
    // 4th within the same window is denied.
    expect(limiter.tryConsume("acct", now)).toBe(false);
  });

  it("does not consume a slot when denied (retry later succeeds once window slides)", () => {
    const limiter = new RateLimiter(1, 1000);
    const t0 = 5000;
    expect(limiter.tryConsume("a", t0)).toBe(true);
    expect(limiter.tryConsume("a", t0)).toBe(false); // denied
    // After the window passes, the old hit ages out and a new send is allowed.
    expect(limiter.tryConsume("a", t0 + 1001)).toBe(true);
  });

  it("isolates accounts (one account's cap does not affect another)", () => {
    const limiter = new RateLimiter(1, 60_000);
    const now = 10;
    expect(limiter.tryConsume("a", now)).toBe(true);
    expect(limiter.tryConsume("a", now)).toBe(false);
    // Different account still has its full allowance.
    expect(limiter.tryConsume("b", now)).toBe(true);
  });

  it("reset clears an account's recorded hits", () => {
    const limiter = new RateLimiter(1, 60_000);
    const now = 10;
    expect(limiter.tryConsume("a", now)).toBe(true);
    expect(limiter.tryConsume("a", now)).toBe(false);
    limiter.reset("a");
    expect(limiter.tryConsume("a", now)).toBe(true);
  });
});
