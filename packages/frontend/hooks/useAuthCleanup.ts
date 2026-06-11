import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';

import { cleanupUserSession } from '@/lib/auth/sessionCleanup';

/**
 * Watches the authenticated user id and runs {@link cleanupUserSession}
 * whenever it transitions away from a previously-set value — i.e. on logout,
 * session expiry, `logoutAll`, or account switch.
 *
 * Mount exactly once (in `AppGate`). Because it keys off `user?.id` rather than
 * a specific sign-out call site, it also covers sign-outs initiated from Oxy's
 * own account bottom sheet, which the app never calls directly.
 */
export function useAuthCleanup(): void {
  const { user } = useOxy();
  const queryClient = useQueryClient();
  const previousUserIdRef = useRef<string | null>(user?.id ?? null);

  useEffect(() => {
    const currentUserId = user?.id ?? null;
    const previousUserId = previousUserIdRef.current;

    // Only act on a real transition away from a logged-in user. This fires on
    // logout (id → null) and account switch (id A → id B); it does NOT fire on
    // first login (null → id), where there's nothing to clean up.
    if (previousUserId && previousUserId !== currentUserId) {
      void cleanupUserSession(queryClient);
    }

    previousUserIdRef.current = currentUserId;
  }, [user?.id, queryClient]);
}
