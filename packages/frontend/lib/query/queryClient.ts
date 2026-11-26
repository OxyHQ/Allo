/**
 * Allo's React Query client.
 *
 * Services 15 holds no React Query cache: `OxyProvider` no longer mounts a
 * client, so `AppProviders` mounts this one above it. The defaults are the ones
 * Services 14's client gave Allo's reads (privacy, profiles, people search),
 * so nothing about when a read retries, goes stale or refetches changes.
 *
 * Every query and mutation here belongs to the signed-in account, and none is
 * persisted: `accountQueryCache` drops them all on an account change.
 */
import { retryAfterSecondsOf } from '@oxy.so/core';
import { onlineManager, QueryClient } from '@tanstack/react-query';

import { createAccountQueryCache } from './accountQueryCache';

const MAX_QUERY_RETRIES = 2;
/** The longest a query waits, silently, for a refusal's `Retry-After`. */
const MAX_RETRY_AFTER_MS = 30_000;

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const value =
    (error as { status?: unknown }).status ??
    (error as { response?: { status?: unknown } }).response?.status;
  return typeof value === 'number' ? value : null;
}

const retryAfterMs = (error: unknown): number => (retryAfterSecondsOf(error) ?? 0) * 1000;

/** What the refusal asked for (`Retry-After`), else exponential backoff. */
export function queryRetryDelay(attemptIndex: number, error: unknown): number {
  return retryAfterMs(error) || Math.min(1000 * 2 ** attemptIndex, 30_000);
}

/** Retry only failures another attempt can plausibly change. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_QUERY_RETRIES) return false;
  if (retryAfterMs(error) > MAX_RETRY_AFTER_MS) return false;
  const status = statusOf(error);
  if (status === null) return true; // a transport error, no HTTP answer
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function createAppQueryClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        gcTime: 30 * 60 * 1000,
        retry: shouldRetryQuery,
        retryDelay: queryRetryDelay,
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        networkMode: 'offlineFirst',
      },
      mutations: {
        retry: false,
        networkMode: 'offlineFirst',
      },
    },
  });
  // Paused mutations resume the moment the network is back.
  onlineManager.subscribe((online) => {
    if (online) void client.getMutationCache().resumePausedMutations();
  });
  return client;
}

/** The app's one client. */
export const queryClient = createAppQueryClient();

/** The app's account cache over it (`AccountQueryScope` keeps it on the session). */
export const accountQueryCache = createAccountQueryCache(queryClient);
