import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useOxy } from '@oxyhq/services';
import type { User } from '@oxyhq/core';

import {
  addModeratedUser,
  DEFAULT_PRIVACY_SETTINGS,
  fetchModeratedUserIds,
  fetchMyPrivacySettings,
  removeModeratedUser,
  updateMyPrivacySettings,
  type AlloPrivacySettings,
  type ModerationList,
} from '@/lib/privacy/api';

/**
 * READING AND WRITING THIS ACCOUNT'S PRIVACY SETTINGS.
 *
 * React Query rather than `useState` + `useEffect`, which is the house rule and
 * earns its keep here specifically: the privacy list draws the online-status
 * switch, and three sub-screens each write one field of the SAME document. A
 * query cache is what makes "toggle presence, open Blocked, come back" show the
 * value that was saved rather than a second fetch's idea of it — and what makes
 * the list update when a sub-screen writes, without either screen knowing the
 * other exists.
 *
 * The keys are exported because invalidation is the entire mechanism by which
 * that happens, and a key typed as a literal in four places is a key that will be
 * misspelled in one of them.
 */

export const privacyQueryKeys = {
  settings: ['privacy', 'settings'] as const,
  moderated: (list: ModerationList) => ['privacy', 'moderated', list] as const,
};

/**
 * This account's settings, with the schema defaults standing in until they
 * arrive.
 *
 * Never `undefined`, so no caller has to draw a switch with no position. `saved`
 * says whether what is on screen is a real answer or the default, which is what
 * the list uses to decide whether to disable the row rather than flash a value
 * the user did not choose.
 */
export function useMyPrivacySettings(): {
  settings: AlloPrivacySettings;
  saved: boolean;
  failed: boolean;
} {
  const query = useQuery({
    queryKey: privacyQueryKeys.settings,
    queryFn: fetchMyPrivacySettings,
  });

  return {
    settings: query.data ?? DEFAULT_PRIVACY_SETTINGS,
    saved: query.data !== undefined,
    failed: query.isError,
  };
}

/**
 * Writes one or more fields, showing the change before the server confirms it.
 *
 * Optimistic because the only control that writes without leaving the screen is
 * a switch, and a switch that waits for a round trip before moving reads as
 * broken. The rollback is the whole reason the previous value is captured: a
 * failed write must put the switch back, or the app is showing a setting the
 * server does not have.
 */
export function useUpdatePrivacySettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (patch: Partial<AlloPrivacySettings>) => updateMyPrivacySettings(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: privacyQueryKeys.settings });
      const previous = queryClient.getQueryData<AlloPrivacySettings>(privacyQueryKeys.settings);
      queryClient.setQueryData<AlloPrivacySettings>(privacyQueryKeys.settings, {
        ...(previous ?? DEFAULT_PRIVACY_SETTINGS),
        ...patch,
      });
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(privacyQueryKeys.settings, context.previous);
      }
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(privacyQueryKeys.settings, settings);
    },
  });
}

/**
 * A person on one of the two moderation lists.
 *
 * `handle` and `displayName` are absent when the account could not be resolved —
 * it was deleted, or it is not visible to this viewer. The row still draws, with
 * the id, because a person you cannot see is still a person you blocked and must
 * be able to unblock.
 */
export interface ModeratedUser {
  readonly id: string;
  readonly displayName?: string;
  readonly handle?: string;
  readonly avatar?: string;
}

function toModeratedUser(user: User): ModeratedUser {
  const handle = typeof user.handle === 'string' ? user.handle : undefined;
  return {
    id: user.id,
    displayName: user.name?.displayName ?? user.username ?? handle,
    handle: user.username ?? handle,
    avatar: user.avatar ?? undefined,
  };
}

/**
 * The people on a list, resolved from the ids the endpoint stores.
 *
 * Two queries rather than one because they invalidate on different events: the
 * ids change when the reader blocks somebody, the profiles change when somebody
 * renames themselves, and folding them together would refetch every profile on
 * every unblock.
 *
 * `getUsersByIds` and not `getUserById` in a loop — one request per chunk rather
 * than one per row. Ids that resolve to nothing are kept as bare rows rather than
 * dropped: silently shortening the list would tell the reader they had unblocked
 * somebody they had not.
 */
export function useModeratedUsers(list: ModerationList): {
  users: readonly ModeratedUser[];
  loading: boolean;
  failed: boolean;
} {
  const { oxyServices } = useOxy();

  const ids = useQuery({
    queryKey: privacyQueryKeys.moderated(list),
    queryFn: () => fetchModeratedUserIds(list),
  });

  const idList = ids.data;

  const profiles = useQuery({
    queryKey: ['privacy', 'moderated', list, 'profiles', idList ?? []] as const,
    queryFn: () => oxyServices.getUsersByIds([...(idList ?? [])]),
    enabled: idList !== undefined && idList.length > 0,
  });

  const users = useMemo<readonly ModeratedUser[]>(() => {
    if (idList === undefined) return [];
    const byId = new Map((profiles.data ?? []).map((user) => [user.id, toModeratedUser(user)]));
    return idList.map((id) => byId.get(id) ?? { id });
  }, [idList, profiles.data]);

  return {
    users,
    loading: ids.isPending || (idList !== undefined && idList.length > 0 && profiles.isPending),
    failed: ids.isError,
  };
}

export function useAddModeratedUser(list: ModerationList) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => addModeratedUser(list, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: privacyQueryKeys.moderated(list) });
    },
  });
}

export function useRemoveModeratedUser(list: ModerationList) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => removeModeratedUser(list, userId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: privacyQueryKeys.moderated(list) });
    },
  });
}
