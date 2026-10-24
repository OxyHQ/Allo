/**
 * A check that failed because the network blinked is asked again by itself.
 *
 * "Cannot check access" used to appear on the first failure of the supervision
 * query (`AlloRoot`) or of a supervised transcript's refresh
 * (`ConversationReadGate`) and stay there until somebody pressed Retry, even
 * though the failure was a phone changing networks. Now:
 *
 * - a TRANSIENT failure (nothing came back, a timeout, a 429, a 5xx) is asked
 *   again after each of {@link TRANSIENT_RETRY_DELAYS_MS} while the screen keeps
 *   saying "checking";
 * - only once those are spent, or for a failure another attempt cannot change
 *   (a 401, a 403), is the reader told it could not be checked;
 * - and from then on the screen still recovers by itself: the moment the device
 *   reports it is back online, and every {@link RECOVERY_INTERVAL_MS} for a
 *   transient failure the device did not notice (a captive portal, a server
 *   that was down).
 *
 * Nothing here decides access. A retry that succeeds is the same answer a
 * pressed Retry would have produced.
 */
import { onlineManager } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

/** The waits before each automatic attempt, in order. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [1_000, 3_000, 8_000];

/** How often a transient failure already on screen is asked again. */
export const RECOVERY_INTERVAL_MS = 30_000;

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value =
    (error as { status?: unknown }).status ??
    (error as { response?: { status?: unknown } }).response?.status;
  return typeof value === 'number' ? value : null;
}

/**
 * Whether another attempt could plausibly answer differently: the same rule as
 * the Oxy SDK's query retry, plus `@allo/core`'s `TransportError`, whose status
 * is `0` when no answer came back at all.
 */
export function isTransientFailure(error: unknown): boolean {
  const status = statusOf(error);
  if (status === null || status === 0) return true;
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

/** The wait before automatic attempt `attempt` (0-based), or `null` to stop and say so. */
export function nextRetryDelay(attempt: number, error: unknown): number | null {
  if (!isTransientFailure(error)) return null;
  return TRANSIENT_RETRY_DELAYS_MS[attempt] ?? null;
}

/** One failed answer. `at` must change with every new failure, so a repeat is seen. */
export interface CheckFailure {
  at: number;
  error: unknown;
}

/**
 * Drives the automatic retries for one check. `failure` is the latest failed
 * answer (`null` while there is none — before the first answer and after a
 * success); `retry` asks again. Returns whether the screen should now SAY it
 * failed: `false` while the automatic attempts are still running.
 */
export function useTransientRetry(failure: CheckFailure | null, retry: () => void): boolean {
  // The latest `retry` without re-arming a timer each render.
  const retryRef = useRef(retry);
  useEffect(() => {
    retryRef.current = retry;
  }, [retry]);

  // The failure's identity: a new one is counted and re-arms the timer, a
  // re-render of the same one does neither. A success (`null`) ends the streak.
  const key = failure === null ? null : `failed:${failure.at}`;
  const [streak, setStreak] = useState<{ key: string | null; failures: number }>({
    key: null,
    failures: 0,
  });
  const failures = streak.key === key ? streak.failures : key === null ? 0 : streak.failures + 1;
  if (streak.key !== key) setStreak({ key, failures });

  const delay = failure === null ? null : nextRetryDelay(failures - 1, failure.error);
  const exhausted = failure !== null && delay === null;

  useEffect(() => {
    if (key === null || delay === null) return;
    const timer = setTimeout(() => retryRef.current(), delay);
    return () => clearTimeout(timer);
  }, [key, delay]);

  // Once the failure is on screen: back online asks again at once, and a
  // transient failure is asked again on a slow clock.
  const transient = failure !== null && isTransientFailure(failure.error);
  useEffect(() => {
    if (!exhausted) return;
    const unsubscribe = onlineManager.subscribe((online) => {
      if (online) retryRef.current();
    });
    const timer = transient
      ? setInterval(() => {
          if (onlineManager.isOnline()) retryRef.current();
        }, RECOVERY_INTERVAL_MS)
      : null;
    return () => {
      unsubscribe();
      if (timer) clearInterval(timer);
    };
  }, [exhausted, transient]);

  return exhausted;
}
