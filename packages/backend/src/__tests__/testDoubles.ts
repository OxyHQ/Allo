/**
 * The vitest helpers `bun:test` has no equivalent for.
 *
 * - `mocked(fn)` is a type assertion and nothing else: it tells the compiler a
 *   function that a `mock.module` factory replaced is a `Mock`.
 * - `stubEnv` / `unstubAllEnvs` set (or, with `undefined`, delete) a variable
 *   and put back exactly what was there before, including its absence.
 * - `pollUntil(predicate)` stands in for `expect.poll(...).toBe(true)`: it
 *   re-evaluates the predicate every 50 ms until it holds or 1 s has passed
 *   (vitest's defaults) and returns the last answer for the caller to assert.
 */
import type { Mock } from 'bun:test';

// biome-ignore lint/suspicious/noExplicitAny: mirrors the constraint on bun:test's own `Mock<T>`.
export function mocked<T extends (...args: any[]) => any>(fn: T): Mock<T> {
  return fn as unknown as Mock<T>;
}

const originalEnv = new Map<string, string | undefined>();

export function stubEnv(name: string, value: string | undefined): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function unstubAllEnvs(): void {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
}

export async function pollUntil(
  predicate: () => boolean,
  { timeoutMs = 1_000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}
