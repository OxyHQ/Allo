import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useOxy } from '@oxy.so/services/ui/client';
import type { User } from '@oxy.so/core';

import {
  fetchProfileAppearance,
  profileAppearanceQueryKey,
  type ProfileAppearance,
} from '@/lib/profile/appearance';
import { getHttpStatus } from '@/utils/errors';

/**
 * WHO A PROFILE URL NAMES.
 *
 * One lookup, by HANDLE. `oxyServices.users.byUsername` takes a username;
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
function computeDesign(
  profile: User,
  appearance: ProfileAppearance | null | undefined,
): ProfileDesign {
  const customization = appearance?.profileCustomization;
  return {
    displayName: customization?.displayName || profile.name?.displayName || profile.username || '',
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
    queryFn: () => oxyServices.users.byUsername(username ?? ''),
    enabled: Boolean(username),
    staleTime: PROFILE_STALE_TIME_MS,
    // A handle nobody holds is an answer, not an outage. Retrying it four times
    // turns an instant "no such account" into several seconds of spinner.
    retry: (failureCount, error) => getHttpStatus(error) !== 404 && failureCount < 2,
  });

  const profile = query.data;
  const userId = profile?.id;

  // Allo's own customization (display name, cover). Decoration: a failed read
  // draws the Oxy profile as it is.
  const { data: appearance } = useQuery({
    queryKey: profileAppearanceQueryKey(userId ?? ''),
    queryFn: () => fetchProfileAppearance(userId ?? ''),
    enabled: Boolean(userId),
    staleTime: PROFILE_STALE_TIME_MS,
  });

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
