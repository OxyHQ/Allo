import { useMemo } from 'react';
import { useUserById } from '@/stores/usersStore';
import { useOxy } from '@oxyhq/services';

/**
 * Hook to get user name from Oxy user data
 * @param userId User ID to get name for
 * @returns User's display name (full name or username)
 */
export function useUserName(userId?: string): string | undefined {
  const { user: currentUser } = useOxy();
  const user = useUserById(userId);

  return useMemo(() => {
    if (!userId) return undefined;

    // If it's the current user, use current user data
    if (userId === currentUser?.id) {
      if (typeof currentUser.name === 'string') {
        return currentUser.name;
      }
      return currentUser.name?.full || currentUser.name?.first || currentUser.username;
    }

    // Otherwise, use fetched user data
    if (!user) return undefined;

    // Handle different name formats from Oxy
    if (typeof user.name === 'string') {
      return user.name;
    }

    if (user.name?.full) {
      return user.name.full;
    }

    if (user.name?.first) {
      const lastName = user.name.last ? ` ${user.name.last}` : '';
      return `${user.name.first}${lastName}`;
    }

    return user.username || user.handle;
  }, [userId, user, currentUser]);
}

/**
 * Hook to get user's first name from Oxy user data
 * @param userId User ID to get first name for
 * @returns User's first name
 */
export function useUserFirstName(userId?: string): string | undefined {
  const { user: currentUser } = useOxy();
  const user = useUserById(userId);

  return useMemo(() => {
    if (!userId) return undefined;

    // If it's the current user, use current user data
    if (userId === currentUser?.id) {
      if (typeof currentUser.name === 'string') {
        return currentUser.name.split(' ')[0];
      }
      return currentUser.name?.first || currentUser.username;
    }

    // Otherwise, use fetched user data
    if (!user) return undefined;

    if (typeof user.name === 'string') {
      return user.name.split(' ')[0];
    }

    return user.name?.first || user.username || user.handle;
  }, [userId, user, currentUser]);
}

/**
 * Hook to get user's username from Oxy user data
 * @param userId User ID to get username for
 * @returns User's username
 */
export function useUserUsername(userId?: string): string | undefined {
  const { user: currentUser } = useOxy();
  const user = useUserById(userId);

  return useMemo(() => {
    if (!userId) return undefined;

    // If it's the current user, use current user data
    if (userId === currentUser?.id) {
      return currentUser.username;
    }

    // Otherwise, use fetched user data
    return user?.username || user?.handle;
  }, [userId, user, currentUser]);
}

