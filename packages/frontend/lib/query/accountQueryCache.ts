/**
 * Keeps Allo's React Query cache strictly on the signed-in account.
 *
 * Services 14 did this for the app's queries: on an account change it dropped
 * them from memory before anybody was woken. Services 15 keeps no React Query
 * cache, so Allo does it here, the way Inbox does (Inbox #271): the cache
 * follows the Services runtime's own notification, which runs after the new
 * subject is published and before React renders anything for it.
 *
 * - On every subject change (a switch, a sign-out, a sign-in) each read in
 *   flight is cancelled and every query and mutation is dropped, synchronously.
 *   Nothing of Allo's is persisted, so nothing is restored: the next account
 *   reads its own from the network.
 * - A write that lands later (a mutation's callback, a late answer) is guarded
 *   with the account it was started for: `isActive(account)` is false once the
 *   session has moved on, and the write is skipped.
 */
import type { QueryClient } from '@tanstack/react-query';

/** The runtime surface the cache follows (`useOxyRuntime()` from `@oxy.so/services/runtime`). */
export interface SubjectSource {
  getSnapshot(): { account: { id?: string | null } | null };
  subscribe(listener: () => void): () => void;
}

export interface AccountQueryCache {
  /** The account the cache holds now (`null` signed out, `undefined` before the first activation). */
  readonly account: string | null | undefined;
  /** Moves the cache to `account`, dropping everything the previous one held. */
  activate(account: string | null): void;
  /** Whether a write started for `account` may still land. */
  isActive(account: string | null | undefined): boolean;
}

export function createAccountQueryCache(client: QueryClient): AccountQueryCache {
  let current: string | null | undefined;
  return {
    get account() {
      return current;
    },
    activate(next) {
      if (next === current) return;
      const first = current === undefined;
      current = next;
      if (first) return;
      // Cancel first, so a read in flight for the account left never resolves
      // into the cache; then drop every query and mutation it held.
      void client.cancelQueries();
      client.getQueryCache().clear();
      client.getMutationCache().clear();
    },
    isActive(account) {
      return account !== undefined && account === current;
    },
  };
}

/**
 * Keep `cache` on the runtime's subject: activated now, and again from the
 * runtime's notification on every change, before any component it wakes
 * renders. Returns the disposer.
 */
export function followOxyRuntime(cache: AccountQueryCache, runtime: SubjectSource): () => void {
  const sync = () => cache.activate(runtime.getSnapshot().account?.id ?? null);
  const unsubscribe = runtime.subscribe(sync);
  sync();
  return unsubscribe;
}
