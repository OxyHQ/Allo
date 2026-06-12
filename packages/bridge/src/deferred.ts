/**
 * A promise with externally-controlled, IDEMPOTENT settlement.
 *
 * The login flows park a promise that the HTTP handler awaits (e.g. "the first QR
 * token") while a background gramjs flow races to settle it. That race can try to
 * settle more than once (token arrives AND the flow later fails) or settle AFTER
 * the attempt was torn down (abandon/shutdown). Plain `resolve`/`reject` from the
 * `Promise` executor are NOT safe to call repeatedly in a readable way and offer
 * no "already settled?" signal, so this wrapper makes settlement a once-only,
 * inspectable operation and adds an explicit `cancel()` for teardown.
 *
 * Review findings 6 + 11: settlement must be idempotent (no double-settle) and
 * must not settle after teardown — both are enforced here in one place and reused
 * by every login flow, so the manager can't reintroduce the race ad hoc.
 */
export class Deferred<T> {
  readonly promise: Promise<T>;
  private settled = false;
  private resolveFn!: (value: T) => void;
  private rejectFn!: (reason: Error) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve;
      this.rejectFn = reject;
    });
    // A Deferred that is never awaited-to-rejection would surface as an
    // unhandled rejection; attach a no-op catch so an unawaited cancelled/failed
    // Deferred can't crash the process. The real awaiter still sees the result.
    this.promise.catch(() => undefined);
  }

  /** True once the promise has been resolved, rejected, or cancelled. */
  get isSettled(): boolean {
    return this.settled;
  }

  /** Resolve once; subsequent calls (resolve/reject/cancel) are no-ops. */
  resolve(value: T): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveFn(value);
  }

  /** Reject once; subsequent calls (resolve/reject/cancel) are no-ops. */
  reject(reason: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectFn(reason);
  }

  /**
   * Cancel on teardown: reject (once) with `reason` ONLY if not already settled.
   * Safe to call on an already-settled Deferred (no-op), so teardown paths can
   * call it unconditionally.
   */
  cancel(reason: Error): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectFn(reason);
  }
}
