import { useCallback, useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

import { useOxy } from '@oxyhq/services';

import { useBridgeGhostNamespaces } from '@/hooks/useBridges';
import { useMatrixRuntime } from '@/hooks/useMatrixRuntime';
import {
  ChatPeopleDirectory,
  chatPersonFrom,
  chatPersonOriginOf,
  NO_CHAT_PERSON_REQUESTS,
  viewerServerNameOf,
  type ChatPeopleLookup,
  type ChatPerson,
  type ChatPersonOrigin,
  type ChatPersonRequest,
  type OxyPersonProfile,
} from '@/lib/chat/people';

/**
 * WHO THE PEOPLE ON THIS SCREEN ARE.
 *
 * The React half of `lib/chat/people.ts`: it takes the Matrix user ids a screen
 * is about to draw and answers with people. Every surface in chat that shows
 * somebody goes through this, and nothing else in chat asks Oxy about a person.
 *
 * **No Effect, and no fetch written by hand.** React Query, per the house rule
 * and for the same reason `useProfileData` uses it: a lookup has three outcomes
 * and a hook that derived "loading" from "no answer yet" cannot tell the third
 * one — an account that does not exist — from the first, so it spins forever
 * over somebody who will never arrive. Here the difference decides what is drawn:
 * see `ChatPersonState`.
 *
 * **One entry in the cache per person, one request per batch.** The two are not
 * in tension: the query key is the person, so a member list whose faces were
 * already in the conversation list costs nothing, while `ChatPeopleDirectory`
 * collects every id asked for in the same tick into a single `getUsersByIds`.
 * Thirty people in a group is one request, and the second time it is none.
 */

/**
 * How long somebody stays fresh.
 *
 * Five minutes, the same as `useProfileData` and the same as the Oxy client's
 * own cache, so moving between the conversation list and a conversation does not
 * re-ask for the people in both.
 */
const PERSON_STALE_TIME_MS = 5 * 60 * 1000;

/** Exported because invalidating a person is otherwise a key typed twice. */
export const chatPeopleQueryKeys = {
  byOxyId: (oxyUserId: string) => ['chatPerson', oxyUserId] as const,
};

/** One entry, so a screen with nobody to draw does not allocate a lookup. */
const NO_ENTRIES: readonly ChatPersonEntry[] = [];

interface ChatPersonEntry {
  readonly request: ChatPersonRequest;
  readonly origin: ChatPersonOrigin;
}

/**
 * The people behind a list of Matrix user ids.
 *
 * `requests` must be a stable reference — wrap it in `useMemo` — because it is
 * what decides the set of queries. A new array every render would be a new set
 * of queries every render.
 */
export function useChatPeople(requests: readonly ChatPersonRequest[]): ChatPeopleLookup {
  const { t } = useTranslation();
  const { oxyServices } = useOxy();
  const runtime = useMatrixRuntime();
  const namespaces = useBridgeGhostNamespaces();

  /**
   * The homeserver everybody in this account lives on, read from the viewer's
   * own session — see `matrixServerNameOf` for why it is not configuration.
   *
   * `undefined` before anybody is signed in, which is a state every surface
   * reaches on a cold start, and one where nothing can be claimed about anybody:
   * `chatPersonOriginOf` treats every id as foreign until it is known.
   */
  const serverName = useMemo(() => viewerServerNameOf(runtime.userId), [runtime.userId]);

  const directory = useMemo(() => new ChatPeopleDirectory(oxyServices), [oxyServices]);

  const entries = useMemo<readonly ChatPersonEntry[]>(() => {
    if (requests.length === 0) {
      return NO_ENTRIES;
    }
    return dedupeRequests(requests).map((request) => ({
      request,
      origin: chatPersonOriginOf(request.userId, serverName, namespaces),
    }));
  }, [requests, serverName, namespaces]);

  /**
   * The Oxy accounts to ask about, and nobody else.
   *
   * A bridge's puppet and a foreign user are absent by construction rather than
   * by a disabled query, because "do not ask Oxy about this person" is a rule
   * about correctness and not about saving a request.
   */
  const oxyUserIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of entries) {
      if (entry.origin.kind === 'oxy') {
        ids.add(entry.origin.oxyUserId);
      }
    }
    return [...ids];
  }, [entries]);

  const profiles = useQueries({
    queries: oxyUserIds.map((oxyUserId) => ({
      queryKey: chatPeopleQueryKeys.byOxyId(oxyUserId),
      queryFn: () => directory.load(oxyUserId),
      staleTime: PERSON_STALE_TIME_MS,
      // Two attempts and then the honest sentence. A member list that retried
      // for half a minute would be a list of blank rows for half a minute.
      retry: 1,
    })),
    combine: (results) => results.map((result) => result.data),
  });

  const profileByOxyId = useMemo(() => {
    const byId = new Map<string, OxyPersonProfile | null | undefined>();
    oxyUserIds.forEach((oxyUserId, index) => {
      byId.set(oxyUserId, profiles[index]);
    });
    return byId;
  }, [oxyUserIds, profiles]);

  const unknownPersonLabel = t('chat.person.unknown');

  const people = useMemo(() => {
    const byUserId = new Map<string, ChatPerson>();
    for (const entry of entries) {
      // `null` — not `undefined` — for anybody who is never looked up: there is
      // nothing pending for them, and `undefined` means "the answer has not
      // arrived".
      const profile =
        entry.origin.kind === 'oxy' ? profileByOxyId.get(entry.origin.oxyUserId) : null;
      byUserId.set(
        entry.request.userId,
        chatPersonFrom(entry.request, entry.origin, profile, unknownPersonLabel),
      );
    }
    return byUserId;
  }, [entries, profileByOxyId, unknownPersonLabel]);

  return useCallback(
    (matrixUserId: string) => people.get(matrixUserId),
    [people],
  );
}

/**
 * One person, for a surface that draws exactly one.
 *
 * The same cache and the same batch as {@link useChatPeople}; this is only the
 * shape a caller with a single id would otherwise have to build by hand.
 */
export function useChatPerson(
  request: ChatPersonRequest | undefined,
): ChatPerson | undefined {
  const requests = useMemo(
    () => (request === undefined ? NO_CHAT_PERSON_REQUESTS : [request]),
    [request],
  );
  const people = useChatPeople(requests);
  return request === undefined ? undefined : people(request.userId);
}

/**
 * One request per person, keeping whichever of the duplicates carries a name.
 *
 * The same person turns up twice all the time — several messages in a row from
 * one sender, somebody who is in the room and also sent its latest message — and
 * only some of those places have Matrix's own display name to offer.
 */
function dedupeRequests(
  requests: readonly ChatPersonRequest[],
): readonly ChatPersonRequest[] {
  const byUserId = new Map<string, ChatPersonRequest>();
  for (const request of requests) {
    const existing = byUserId.get(request.userId);
    if (existing === undefined) {
      byUserId.set(request.userId, request);
      continue;
    }
    if (existing.matrixDisplayName === undefined && request.matrixDisplayName !== undefined) {
      byUserId.set(request.userId, request);
    }
  }
  return [...byUserId.values()];
}
