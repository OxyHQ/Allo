/**
 * Route utilities for consistent route matching across the application
 */

/**
 * Application route constants
 */
export const ROUTES = {
  HOME: '/',
  STATUS: '/(chat)/status',
  CALLS: '/calls',
  SETTINGS: '/(chat)/settings',
  CHAT_INDEX: '/(chat)',
} as const;

/**
 * Route matching options
 */
export interface RouteMatchOptions {
  exact?: boolean;
  startsWith?: boolean;
  endsWith?: boolean;
  includes?: boolean;
}

/**
 * Checks if a pathname matches a route pattern
 * 
 * @param pathname - Current pathname from usePathname()
 * @param route - Route pattern to match against
 * @param options - Matching options
 * @returns true if the pathname matches the route
 * 
 * @example
 * ```ts
 * isRouteActive('/(chat)/status', ROUTES.STATUS) // true
 * isRouteActive('/some/path/status', ROUTES.STATUS) // true (ends with /status)
 * ```
 */
export const isRouteActive = (
  pathname: string | null | undefined,
  route: string,
  options: RouteMatchOptions = {}
): boolean => {
  if (!pathname) return false;

  const { exact = false, startsWith = false, endsWith = false, includes = false } = options;

  // Handle home route specially
  if (route === ROUTES.HOME) {
    return pathname === '/' || pathname === '';
  }

  // Exact match
  if (exact || (!startsWith && !endsWith && !includes)) {
    return pathname === route;
  }

  // Starts with match
  if (startsWith) {
    return pathname.startsWith(route);
  }

  // Ends with match
  if (endsWith) {
    return pathname.endsWith(route);
  }

  // Includes match
  if (includes) {
    return pathname.includes(route);
  }

  return false;
};

/**
 * Special route matchers for common patterns
 */
export const routeMatchers = {
  /**
   * Checks if current pathname matches the status route
   * Handles various pathname formats that Expo Router might use
   */
  isStatusRoute: (pathname: string | null | undefined): boolean => {
    if (!pathname) return false;
    return (
      pathname === ROUTES.STATUS ||
      pathname === '/status' ||
      pathname.endsWith('/status') ||
      pathname.includes('/status')
    );
  },

  /**
   * Checks if current pathname matches the settings route
   */
  isSettingsRoute: (pathname: string | null | undefined): boolean => {
    if (!pathname) return false;
    return pathname.includes('/settings');
  },

  /**
   * Checks if current pathname matches the home route
   */
  isHomeRoute: (pathname: string | null | undefined): boolean => {
    if (!pathname) return false;
    return pathname === '/' || pathname === '';
  },

  /**
   * Checks if current pathname matches a conversation route
   */
  isConversationRoute: (pathname: string | null | undefined): boolean => {
    if (!pathname) return false;
    const conversationIdMatch = pathname.match(/\/c\/([^/]+)$/);
    return Boolean(conversationIdMatch);
  },
};

