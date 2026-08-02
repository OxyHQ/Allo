import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
  listBridgeAccounts,
  listBridgeNetworks,
  reconnectBridgeAccount,
  unlinkBridgeAccount,
} from '@/lib/bridges/api';
import type { BridgeAccount } from '@/lib/bridges/contract';
import { CHAT_BACKEND } from '@/lib/chat/backend';
import { ghostNamespacesFor, type GhostNamespace } from '@/lib/chat/roomOrigin';

/**
 * Reading the bridge catalogue and this user's linked accounts.
 *
 * React Query rather than `useState` + `useEffect`, which is the house rule and
 * has a specific payoff here: the linked-accounts screen, the linking flow and
 * the conversation list all want the same two lists, and a query cache is what
 * stops that being three fetches and three copies that disagree while one of them
 * is in flight.
 *
 * `queryKeys` is exported because invalidation is the whole mechanism by which
 * the list updates after a link, an unlink or a reconnect, and a key typed as a
 * literal in five call sites is a key that will be misspelled in one of them.
 */

export const bridgeQueryKeys = {
  networks: ['bridges', 'networks'] as const,
  accounts: ['bridges', 'accounts'] as const,
};

/**
 * Whether this build can have bridged conversations at all.
 *
 * Bridges are appservices on Allo's homeserver; a build talking to the Express
 * API has no rooms for them to appear in. Gating on the flag keeps the
 * conversation list from making two authenticated requests per launch that could
 * not change anything it draws.
 */
const bridgesReachable = CHAT_BACKEND === 'matrix';

/**
 * The networks this deployment offers.
 *
 * There is no `enabled: false` branch: the settings screen must be able to say
 * "no networks are available" from an answer, and a query that never ran cannot
 * tell that apart from one that is still loading. The flag gates the conversation
 * list's use of this data, not the settings screen's.
 */
export function useBridgeNetworks() {
  return useQuery({
    queryKey: bridgeQueryKeys.networks,
    queryFn: listBridgeNetworks,
  });
}

export function useBridgeAccounts() {
  return useQuery({
    queryKey: bridgeQueryKeys.accounts,
    queryFn: listBridgeAccounts,
  });
}

/**
 * The ghost-user namespaces the conversation list needs to recognise a bridged
 * room.
 *
 * Derived from the user's LINKED accounts rather than from every enabled network:
 * a network nobody linked cannot have produced a room in this account, so its
 * namespace would only widen the surface on which a real user id could be
 * mistaken for a ghost.
 *
 * Returns an empty list — a stable one — while the accounts are loading, when the
 * request failed, and always under the Express backend. Every one of those cases
 * means "no room is known to be bridged", which is what `roomOrigin.ts` treats as
 * the answer that says less rather than the answer that claims more.
 */
export function useBridgeGhostNamespaces(): readonly GhostNamespace[] {
  const { data } = useQuery({
    queryKey: bridgeQueryKeys.accounts,
    queryFn: listBridgeAccounts,
    enabled: bridgesReachable,
  });

  return useMemo(() => {
    if (!bridgesReachable || data === undefined) return NO_NAMESPACES;
    const networkIds = [...new Set(data.map((account) => account.network))];
    return networkIds.length === 0 ? NO_NAMESPACES : ghostNamespacesFor(networkIds);
  }, [data]);
}

/** One identity, so a list that has not changed does not re-render the whole list. */
const NO_NAMESPACES: readonly GhostNamespace[] = [];

/**
 * Both lists after a change that could have altered either.
 *
 * Unlinking removes an account and reconnecting changes its state, so both touch
 * `accounts`; linking additionally consumes a per-network slot, which is a fact
 * the catalogue does not carry but the screens read alongside it. Invalidating
 * the pair keeps the two in step for the cost of one small request.
 */
function useInvalidateBridges() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: bridgeQueryKeys.accounts });
    void queryClient.invalidateQueries({ queryKey: bridgeQueryKeys.networks });
  };
}

export function useUnlinkBridgeAccount() {
  const invalidate = useInvalidateBridges();
  return useMutation({
    mutationFn: (accountId: string) => unlinkBridgeAccount(accountId),
    onSuccess: invalidate,
  });
}

export function useReconnectBridgeAccount() {
  const invalidate = useInvalidateBridges();
  return useMutation({
    mutationFn: (accountId: string) => reconnectBridgeAccount(accountId),
    onSuccess: invalidate,
  });
}

/**
 * Which of a user's accounts belong to a given network.
 *
 * The per-network limit is the server's — `ALLO_BRIDGES_MAX_ACCOUNTS_PER_NETWORK`
 * is not published — so nothing here counts against a number and no row is
 * hidden. A second account on a network that is already at its limit is refused
 * with `too_many_accounts`, and that refusal stays the authority.
 */
export function accountsForNetwork(
  accounts: readonly BridgeAccount[] | undefined,
  networkId: string,
): readonly BridgeAccount[] {
  return accounts?.filter((account) => account.network === networkId) ?? [];
}
