import { Deferred } from "../deferred";

/**
 * The login flows settle parked promises from a background race; settlement MUST
 * be idempotent (no double-settle) and safe AFTER teardown (review findings 6+11).
 */
describe("Deferred — idempotent settlement", () => {
  it("resolves once; a later resolve/reject is ignored", async () => {
    const d = new Deferred<string>();
    d.resolve("first");
    d.resolve("second");
    d.reject(new Error("late"));
    expect(d.isSettled).toBe(true);
    await expect(d.promise).resolves.toBe("first");
  });

  it("rejects once; a later reject/resolve is ignored", async () => {
    const d = new Deferred<string>();
    d.reject(new Error("boom"));
    d.resolve("too-late");
    d.reject(new Error("also-late"));
    expect(d.isSettled).toBe(true);
    await expect(d.promise).rejects.toThrow("boom");
  });

  it("cancel() after resolve is a no-op (does not override the value)", async () => {
    const d = new Deferred<number>();
    d.resolve(42);
    d.cancel(new Error("torn-down"));
    await expect(d.promise).resolves.toBe(42);
  });

  it("cancel() on an unsettled Deferred rejects with the reason (teardown guard)", async () => {
    const d = new Deferred<number>();
    d.cancel(new Error("torn-down"));
    expect(d.isSettled).toBe(true);
    await expect(d.promise).rejects.toThrow("torn-down");
  });

  it("a cancelled/rejected Deferred that is never awaited does not throw unhandled", async () => {
    // The constructor attaches a no-op catch; this must not produce an unhandled
    // rejection even though nothing awaits `.promise`.
    const d = new Deferred<void>();
    d.cancel(new Error("nobody-is-listening"));
    // Give the microtask queue a turn; an unhandled rejection would surface here.
    await new Promise((r) => setTimeout(r, 5));
    expect(d.isSettled).toBe(true);
  });

  it("isSettled flips exactly once across concurrent settle attempts", async () => {
    const d = new Deferred<string>();
    // Fire many settle attempts "concurrently"; only the first wins.
    const attempts = [
      () => d.resolve("a"),
      () => d.reject(new Error("b")),
      () => d.resolve("c"),
      () => d.cancel(new Error("d")),
    ];
    attempts.forEach((fn) => fn());
    await expect(d.promise).resolves.toBe("a");
    expect(d.isSettled).toBe(true);
  });
});
