import { useMemo } from 'react';
import { useUserById } from '@/stores/usersStore';
import { useOxy } from '@oxyhq/services';

/**
 * Hook to get a user's canonical display name from Oxy user data.
 *
 * The Oxy API owns `name.displayName` as the required canonical display string;
 * render it directly. We never recompose names from `first` / `last` / `full`.
 *
 * @param userId User ID to get name for
 * @returns User's display name (falls back to username only when the user object
 *          has not loaded a structured name yet)
 */
export function useUserName(userId?: string): string | undefined {
  const { user: currentUser } = useOxy();
  const user = useUserById(userId);

  return useMemo(() => {
    if (!userId) return undefined;

    // If it's the current user, use current user data
    if (userId === currentUser?.id) {
      return currentUser.name?.displayName || currentUser.username;
    }

    // Otherwise, use fetched user data
    if (!user) return undefined;

    const name = typeof user.name === 'string' ? undefined : user.name;
    return name?.displayName || user.username || user.handle;
  }, [userId, user, currentUser]);
}

