import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useOxy } from '@oxyhq/services';
import type { User } from '@oxyhq/core';

import { useAppearanceStore, type UserAppearance } from '@/stores/appearanceStore';
import { getHttpStatus } from '@/utils/errors';

/**
 * WHO A PROFILE URL NAMES.
 *
 * One lookup, by HANDLE. `oxyServices.getProfileByUsername` takes a username;
 * `getUserById` takes an account id. Passing an id to the by-username endpoint
 * 404s — quietly, once per render — and that exact confusion shipped once
 * already; `hooks/useSenderInfo.ts` carries the note. Everything that arrives at
 * this hook comes out of a `/@handle` URL, so there is only ever a handle here.
 *
 * React Query rather than `useState` + `useEffect`, for a reason beyond the house
 * rule: the old shape derived `loading` as "asked for a username and have no
 * profile", which is also what "no such account" looks like, so an unknown handle
 * span forever instead of saying so. A query has three outcomes and this hook
 * reports all three.
 */

export interface ProfileDesign {
  displayName: string;
  coverImage?: string;
  avatar?: string;
  coverPhotoEnabled: boolean;
  minimalistMode: boolean;
}

export interface ProfileData {
  id: string;
  username: string;
  bio?: string;
  verified?: boolean;
  avatar?: string;
  design: ProfileDesign;
}

export const profileQueryKeys = {
  byUsername: (username: string) => ['profile', 'byUsername', username] as const,
};

/**
 * How long a profile stays fresh.
 *
 * Five minutes, matching the Oxy client's own cache TTL for the same call, so a
 * navigation back to a profile does not re-request what the SDK would have
 * answered from memory anyway.
 */
const PROFILE_STALE_TIME_MS = 5 * 60 * 1000;

/** The display name, honouring the override the user set in Allo's own settings. */
function computeDesign(profile: User, appearance: UserAppearance | undefined): ProfileDesign {
  const customization = appearance?.profileCustomization;
  return {
    displayName:
      customization?.displayName || profile.name?.displayName || profile.username || '',
    coverImage: customization?.coverImage || appearance?.profileHeaderImage,
    avatar: profile.avatar ?? undefined,
    coverPhotoEnabled: customization?.coverPhotoEnabled ?? true,
    minimalistMode: customization?.minimalistMode ?? false,
  };
}

export function useProfileData(username?: string): {
  data: ProfileData | null;
  loading: boolean;
  /** The lookup finished and the handle belongs to nobody. */
  notFound: boolean;
  /** The lookup failed for a reason that is not "no such account". */
  failed: boolean;
} {
  const { oxyServices } = useOxy();

  const query = useQuery({
    queryKey: profileQueryKeys.byUsername(username ?? ''),
    queryFn: () => oxyServices.getProfileByUsername(username ?? ''),
    enabled: Boolean(username),
    staleTime: PROFILE_STALE_TIME_MS,
    // A handle nobody holds is an answer, not an outage. Retrying it four times
    // turns an instant "no such account" into several seconds of spinner.
    retry: (failureCount, error) => getHttpStatus(error) !== 404 && failureCount < 2,
  });

  const profile = query.data;
  const userId = profile?.id;

  const appearance = useAppearanceStore((state) =>
    userId ? state.byUserId[userId] : undefined,
  );
  const loadForUser = useAppearanceStore((state) => state.loadForUser);

  /**
   * Allo's own customization for this account, which lives in a Zustand store
   * outside React and is shared with `useAvatarShape` and the theme.
   *
   * An Effect because that is what synchronising with an external store is: the
   * store caches per user id and ignores a repeat, so this settles after one
   * request per profile. Putting the same document in the query cache as well
   * would give the avatar shape and the cover photo two sources that disagree.
   */
  useEffect(() => {
    if (userId) {
      void loadForUser(userId);
    }
  }, [userId, loadForUser]);

  const data = useMemo<ProfileData | null>(() => {
    if (!profile) return null;
    return {
      id: profile.id,
      username: profile.username ?? '',
      bio: typeof profile.bio === 'string' ? profile.bio : undefined,
      verified: profile.verified === true,
      avatar: profile.avatar ?? undefined,
      design: computeDesign(profile, appearance),
    };
  }, [profile, appearance]);

  const status = query.isError ? getHttpStatus(query.error) : undefined;

  return {
    data,
    loading: Boolean(username) && query.isPending,
    notFound: status === 404,
    failed: query.isError && status !== 404,
  };
}
