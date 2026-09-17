/** Small concurrency primitives. No timers survive `stop()`: every one is tracked by its owner. */

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A FIFO async mutex. `run` serialises state-changing work so one live copy of any state is ever mutated. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Exponential backoff with full jitter: 1 s → cap, never zero. */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 60_000, random: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.max(baseMs / 2, Math.floor(random() * exp));
}

/** Resolves when `predicate` is true, polling; rejects after `timeoutMs`. Tests use it; the SDK does not. */
export async function until(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error("until: timed out");
    await sleep(stepMs);
  }
}

/** A deferred promise. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
