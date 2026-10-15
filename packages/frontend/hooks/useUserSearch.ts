import { useMessagingSupervision } from '@/lib/allo/MessagingSupervision';
import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useOxy } from '@oxy.so/services';

/**
 * FINDING A PERSON BY TYPING.
 *
 * The privacy screens need it to add somebody to a list, and they need it to
 * behave the same way the new-chat screen's search does — same minimum length,
 * same pause before a request goes out — because it is the same act. Extracted as
 * a hook rather than copied so the two cannot drift apart into two different
 * ideas of when a search has started.
 */

export interface SearchedUser {
  readonly id: string;
  readonly displayName: string;
  readonly handle: string;
  readonly avatar?: string;
}

/**
 * Below this, a search matches most of the directory and tells the reader
 * nothing. The same threshold `app/(chat)/new.tsx` uses.
 */
export const MIN_SEARCH_LENGTH = 2;

/** How long a typist has to pause before the request goes out. */
const DEBOUNCE_MS = 300;

const MAX_RESULTS = 20;

const NO_RESULTS: readonly SearchedUser[] = [];

export function useUserSearch(): {
  /** What is in the field. */
  term: string;
  setTerm: (value: string) => void;
  /** What was actually searched for — the term, one pause later. */
  results: readonly SearchedUser[];
  searching: boolean;
  /** Something is typed, but not yet enough to search for. */
  tooShort: boolean;
  clear: () => void;
  unavailable: boolean;
  retry: () => void;
} {
  const { oxyServices, user, activeSessionId } = useOxy();
  const supervised = useMessagingSupervision();
  const [term, setTermState] = useState('');
  const [settledTerm, setSettledTerm] = useState('');

  /**
   * The pending timer, in a ref.
   *
   * Typing is a user event and the pause is part of handling it, so there is
   * nothing here to synchronise and no Effect. The id has to survive between two
   * keystrokes without causing a render, which is what a ref is for — a `let`
   * captured in a `useMemo` would be the same idea written where React cannot see
   * it, and the compiler rejects it for that reason.
   */
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const settleAfterPause = useCallback((value: string) => {
    if (pending.current !== undefined) clearTimeout(pending.current);
    pending.current = setTimeout(() => setSettledTerm(value), DEBOUNCE_MS);
  }, []);

  const setTerm = useCallback(
    (value: string) => {
      setTermState(value);
      settleAfterPause(value.trim());
    },
    [settleAfterPause],
  );

  /**
   * Clearing is immediate.
   *
   * Waiting out the pause would leave the previous results under an empty field
   * — and this is what runs after somebody is added to a list, where the row they
   * just added would stay on screen offering to be added again.
   */
  const clear = useCallback(() => {
    if (pending.current !== undefined) clearTimeout(pending.current);
    setTermState('');
    setSettledTerm('');
  }, []);

  const enabled = settledTerm.length >= MIN_SEARCH_LENGTH;

  const query = useQuery({
    queryKey: ['users', 'search', user?.id, activeSessionId, supervised, settledTerm] as const,
    queryFn: async (): Promise<readonly SearchedUser[]> => {
      if (supervised) {
        const response = await oxyServices.safety.people({ query: settledTerm });
        return response.items.map((person) => ({
          id: person.accountId,
          displayName: person.displayName ?? person.username ?? '',
          handle: person.username ?? '',
        }));
      }
      const response = await oxyServices.users.search(settledTerm, { limit: MAX_RESULTS });
      return response.data.map((profile) => {
        const handle =
          profile.username ?? (typeof profile.handle === 'string' ? profile.handle : '');
        return {
          id: profile.id,
          displayName: profile.name?.displayName || handle,
          handle,
          avatar: profile.avatar ?? undefined,
        };
      });
    },
    enabled,
    ...(supervised ? { staleTime: 0, refetchOnMount: 'always' as const } : {}),
  });

  return {
    term,
    setTerm,
    results:
      supervised && (!query.isFetchedAfterMount || query.isError)
        ? NO_RESULTS
        : (query.data ?? NO_RESULTS),
    searching: enabled && query.isPending,
    tooShort: term.trim().length > 0 && term.trim().length < MIN_SEARCH_LENGTH,
    clear,
    unavailable: enabled && query.isError,
    retry: () => {
      void query.refetch();
    },
  };
}
