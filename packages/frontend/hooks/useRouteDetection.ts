import { usePathname, useSegments } from 'expo-router';
import { useMemo } from 'react';
import { routeMatchers } from '@/utils/routeUtils';

/**
 * Custom hook for detecting current route type
 * Follows Expo Router 54 best practices with proper hook usage
 */
export function useRouteDetection() {
  const pathname = usePathname();
  const segments = useSegments();

  return useMemo(() => {
    const isSettingsRoute = routeMatchers.isSettingsRoute(pathname);
    const isSettingsIndexRoute = 
      pathname === '/(chat)/settings' || 
      pathname?.endsWith('/settings');
    const isNestedSettingsRoute = isSettingsRoute && !isSettingsIndexRoute;
    const isStatusRoute = routeMatchers.isStatusRoute(pathname);
    const isConversationRoute = routeMatchers.isConversationRoute(pathname);
    
    const lastSegment = segments[segments.length - 1];
    const isIndexRoute = (
      pathname === '/(chat)' ||
      pathname === '/(chat)/' ||
      pathname === '/chat' ||
      pathname === '/chat/' ||
      (String(lastSegment) === 'index' && !isSettingsRoute)
    ) && !isStatusRoute;

    const conversationIdMatch = pathname?.match(/\/c\/([^/]+)$/);
    const conversationId = conversationIdMatch?.[1] || null;

    return {
      pathname,
      segments,
      isSettingsRoute,
      isSettingsIndexRoute,
      isNestedSettingsRoute,
      isStatusRoute,
      isConversationRoute,
      isIndexRoute,
      conversationId,
    };
  }, [pathname, segments]);
}

