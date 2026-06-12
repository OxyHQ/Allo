/**
 * Interop bridge (F3.x) — React Query hooks for the user-facing bridge API.
 *
 * All bridge data is fetched through React Query (no `useEffect` fetching). When
 * `BRIDGE_ENABLED` is off server-side the API throws `BridgeUnavailableError`;
 * these hooks DON'T retry that case and expose it via `isUnavailable` so screens
 * can render a graceful "not available" state.
 */

import { useCallback, useMemo } from 'react';
import { useQuery, useQueryClient, type RefetchOptions, type QueryObserverResult } from '@tanstack/react-query';
import type { Network } from '@allo/shared-types';
import {
  listLinkedAccounts,
  listExternalContacts,
  BridgeUnavailableError,
  type LinkedAccount,
  type ExternalContact,
} from '@/lib/bridge/api';

/** Stable React Query keys for bridge data. */
export const bridgeQueryKeys = {
  accounts: ['bridge', 'accounts'] as const,
  contacts: (network: Network) => ['bridge', 'contacts', network] as const,
};

/** Linked accounts are considered fresh for this long (Telegram-style caching). */
const ACCOUNTS_STALE_MS = 30_000;
/** External contacts change rarely; cache them a bit longer. */
const CONTACTS_STALE_MS = 60_000;

/** True when an error is the "bridge feature disabled" (404) signal. */
function isBridgeUnavailable(error: unknown): boolean {
  return error instanceof BridgeUnavailableError;
}

/** Never retry the "feature unavailable" case; retry transient errors once. */
function bridgeRetry(failureCount: number, error: unknown): boolean {
  if (isBridgeUnavailable(error)) return false;
  return failureCount < 1;
}

export interface UseLinkedAccountsResult {
  accounts: LinkedAccount[];
  isLoading: boolean;
  isError: boolean;
  /** True when the backend reports the bridge feature is disabled (404). */
  isUnavailable: boolean;
  refetch: (
    options?: RefetchOptions
  ) => Promise<QueryObserverResult<LinkedAccount[], unknown>>;
}

/**
 * Fetch the user's linked external accounts. Shared query key, so every consumer
 * (settings screen, new-chat, each conversation) reuses ONE cached request.
 * Pass `enabled: false` to skip the request entirely (e.g. native-only chats
 * that never need bridge state).
 */
export function useLinkedAccounts(enabled = true): UseLinkedAccountsResult {
  const query = useQuery({
    queryKey: bridgeQueryKeys.accounts,
    queryFn: listLinkedAccounts,
    enabled,
    staleTime: ACCOUNTS_STALE_MS,
    retry: bridgeRetry,
  });

  return {
    accounts: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError && !isBridgeUnavailable(query.error),
    isUnavailable: isBridgeUnavailable(query.error),
    refetch: query.refetch,
  };
}

/**
 * Look up a single network's linked account from the cached accounts list.
 * Returns `undefined` while loading or when the network isn't linked. Pass
 * `enabled: false` to avoid fetching at all (native conversations).
 */
export function useLinkedAccount(
  network: Network,
  enabled = true
): {
  account: LinkedAccount | undefined;
  isActive: boolean;
  isLoading: boolean;
  isUnavailable: boolean;
} {
  const { accounts, isLoading, isUnavailable } = useLinkedAccounts(enabled);
  const account = useMemo(
    () => accounts.find((entry) => entry.network === network),
    [accounts, network]
  );
  return {
    account,
    isActive: account?.status === 'active',
    isLoading,
    isUnavailable,
  };
}

export interface UseExternalContactsResult {
  contacts: ExternalContact[];
  isLoading: boolean;
  isError: boolean;
  isUnavailable: boolean;
  refetch: (
    options?: RefetchOptions
  ) => Promise<QueryObserverResult<ExternalContact[], unknown>>;
}

/**
 * Fetch the user's external contacts on a network. Disabled (no request) unless
 * `enabled` is true — callers gate this on "the network has an active account".
 */
export function useExternalContacts(
  network: Network,
  enabled: boolean
): UseExternalContactsResult {
  const query = useQuery({
    queryKey: bridgeQueryKeys.contacts(network),
    queryFn: () => listExternalContacts(network),
    enabled,
    staleTime: CONTACTS_STALE_MS,
    retry: bridgeRetry,
  });

  return {
    contacts: query.data ?? [],
    isLoading: query.isLoading,
    isError: query.isError && !isBridgeUnavailable(query.error),
    isUnavailable: isBridgeUnavailable(query.error),
    refetch: query.refetch,
  };
}

/** Imperative cache invalidation for bridge data (used after link/unlink). */
export function useInvalidateBridge(): {
  invalidateAccounts: () => void;
  invalidateContacts: (network: Network) => void;
} {
  const queryClient = useQueryClient();
  const invalidateAccounts = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: bridgeQueryKeys.accounts });
  }, [queryClient]);
  const invalidateContacts = useCallback(
    (network: Network) => {
      void queryClient.invalidateQueries({ queryKey: bridgeQueryKeys.contacts(network) });
    },
    [queryClient]
  );
  return { invalidateAccounts, invalidateContacts };
}
