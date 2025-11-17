import { usePathname, useSegments } from 'expo-router';
import { useMemo } from 'react';
import { routeMatchers, ROUTE_PATTERNS } from '@/utils/routeUtils';

/**
 * Route detection result type
 */
export interface RouteDetectionResult {
  pathname: string | null;
  segments: string[];
  isSettingsRoute: boolean;
  isSettingsIndexRoute: boolean;
  isNestedSettingsRoute: boolean;
  isStatusRoute: boolean;
  isConversationRoute: boolean;
  isIndexRoute: boolean;
  conversationId: string | null;
}

/**
 * Custom hook for detecting current route type
 * 
 * Follows Expo Router 54 best practices:
 * - Uses usePathname() and useSegments() hooks
 * - Memoized for performance
 * - Returns type-safe route detection results
 * 
 * @returns RouteDetectionResult object with route state
 * 
 * @example
 * ```ts
 * const route = useRouteDetection();
 * if (route.isStatusRoute) {
 *   // Handle status route
 * }
 * ```
 */
export function useRouteDetection(): RouteDetectionResult {
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

    // Extract conversation ID using pattern matching
    const conversationIdMatch = pathname?.match(ROUTE_PATTERNS.CONVERSATION);
    const conversationId = conversationIdMatch?.[1] || null;

    return {
      pathname: pathname || null,
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

