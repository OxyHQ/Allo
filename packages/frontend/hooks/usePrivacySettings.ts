import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { useOxy } from '@oxy.so/services/ui/client';
import type { User } from '@oxy.so/core';

import {
  blockUser,
  DEFAULT_PRIVACY_SETTINGS,
  fetchBlockedUserIds,
  fetchMyPrivacySettings,
  unblockUser,
  updateMyPrivacySettings,
  type AlloPrivacySettings,
} from '@/lib/privacy/api';

/**
 * READING AND WRITING THIS ACCOUNT'S PRIVACY SETTINGS.
 *
 * React Query rather than `useState` + `useEffect`, which is the house rule and
 * earns its keep here specifically: the privacy list draws the online-status
 * switch, and the blocked list is a second screen over the same account. A
 * query cache is what makes "toggle presence, open Blocked, come back" show the
 * value that was saved rather than a second fetch's idea of it, and what makes
 * the blocked list update after a block or an unblock.
 *
 * The keys are exported because invalidation is the entire mechanism by which
 * that happens, and a key typed as a literal in several places is a key that
 * will be misspelled in one of them.
 *
 * They carry the account, so an account switch never shows the previous
 * account's settings or lists, and their root is the app's own: `privacy` is
 * the SDK's, which it keeps on disk for the device.
 */
export const privacyQueryKeys = {
  settings: (accountId: string | undefined) => ['alloPrivacy', accountId, 'settings'] as const,
  blocked: (accountId: string | undefined) => ['alloPrivacy', accountId, 'blocked'] as const,
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
  const { user } = useOxy();
  const query = useQuery({
    queryKey: privacyQueryKeys.settings(user?.id),
    queryFn: fetchMyPrivacySettings,
  });

  return {
    settings: query.data ?? DEFAULT_PRIVACY_SETTINGS,
    saved: query.data !== undefined,
    failed: query.isError,
  };
}

/**
 * Writes the setting, showing the change before the server confirms it.
 *
 * Optimistic because the only control that writes without leaving the screen is
 * a switch, and a switch that waits for a round trip before moving reads as
 * broken. The rollback is the whole reason the previous value is captured: a
 * failed write must put the switch back, or the app is showing a setting the
 * server does not have.
 */
export function useUpdatePrivacySettings() {
  const queryClient = useQueryClient();
  const { user } = useOxy();
  const key = privacyQueryKeys.settings(user?.id);

  return useMutation({
    mutationFn: (patch: Partial<AlloPrivacySettings>) => updateMyPrivacySettings(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<AlloPrivacySettings>(key);
      queryClient.setQueryData<AlloPrivacySettings>(key, {
        ...(previous ?? DEFAULT_PRIVACY_SETTINGS),
        ...patch,
      });
      return { previous };
    },
    onError: (_error, _patch, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(key, context.previous);
      }
    },
    onSuccess: (settings) => {
      queryClient.setQueryData(key, settings);
    },
  });
}

/**
 * A person on the blocked list.
 *
 * `handle` and `displayName` are absent when the account could not be resolved —
 * it was deleted, or it is not visible to this viewer. The row still draws, with
 * the id, because a person you cannot see is still a person you blocked and must
 * be able to unblock.
 */
export interface BlockedUser {
  readonly id: string;
  readonly displayName?: string;
  readonly handle?: string;
  readonly avatar?: string;
}

function toBlockedUser(user: User): BlockedUser {
  const handle = typeof user.handle === 'string' ? user.handle : undefined;
  return {
    id: user.id,
    displayName: user.name?.displayName ?? user.username ?? handle,
    handle: user.username ?? handle,
    avatar: user.avatar ?? undefined,
  };
}

/**
 * The people this account has blocked, resolved from the ids the endpoint stores.
 *
 * Two queries rather than one because they invalidate on different events: the
 * ids change when the reader blocks somebody, the profiles change when somebody
 * renames themselves, and folding them together would refetch every profile on
 * every unblock.
 *
 * `users.getMany` and not `users.get` in a loop — one request per chunk rather
 * than one per row. Ids that resolve to nothing are kept as bare rows rather than
 * dropped: silently shortening the list would tell the reader they had unblocked
 * somebody they had not.
 */
export function useBlockedUsers(): {
  users: readonly BlockedUser[];
  loading: boolean;
  failed: boolean;
} {
  const { oxyServices, user } = useOxy();
  const listKey = privacyQueryKeys.blocked(user?.id);

  const ids = useQuery({
    queryKey: listKey,
    queryFn: fetchBlockedUserIds,
  });

  const idList = ids.data;

  const profiles = useQuery({
    queryKey: [...listKey, 'profiles', idList ?? []] as const,
    queryFn: () => oxyServices.users.getMany([...(idList ?? [])]),
    enabled: idList !== undefined && idList.length > 0,
  });

  const users = useMemo<readonly BlockedUser[]>(() => {
    if (idList === undefined) return [];
    const byId = new Map((profiles.data ?? []).map((user) => [user.id, toBlockedUser(user)]));
    return idList.map((id) => byId.get(id) ?? { id });
  }, [idList, profiles.data]);

  return {
    users,
    loading: ids.isPending || (idList !== undefined && idList.length > 0 && profiles.isPending),
    failed: ids.isError,
  };
}

export function useBlockUser() {
  const queryClient = useQueryClient();
  const { user } = useOxy();
  return useMutation({
    mutationFn: blockUser,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: privacyQueryKeys.blocked(user?.id) });
    },
  });
}

export function useUnblockUser() {
  const queryClient = useQueryClient();
  const { user } = useOxy();
  return useMutation({
    mutationFn: unblockUser,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: privacyQueryKeys.blocked(user?.id) });
    },
  });
}
