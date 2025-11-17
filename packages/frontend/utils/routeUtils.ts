/**
 * Route utilities for consistent route matching across the application
 * 
 * Follows Expo Router 54 conventions and best practices
 */

/**
 * Application route constants
 * Centralized route definitions for type safety and maintainability
 */
export const ROUTES = {
  HOME: '/',
  STATUS: '/(chat)/status',
  CALLS: '/calls',
  SETTINGS: '/(chat)/settings',
  CHAT_INDEX: '/(chat)',
} as const;

/**
 * Type for route keys
 */
export type RouteKey = keyof typeof ROUTES;

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
 * Route pattern constants for consistent matching
 */
export const ROUTE_PATTERNS = {
  CONVERSATION: /^\/c\/([^/]+)$/,
  PROFILE: /^\/@([^/]+)$/,
  SETTINGS: /\/settings/,
  STATUS: /\/status/,
} as const;

/**
 * Special route matchers for common patterns
 * Provides type-safe route detection utilities
 */
export const routeMatchers = {
  /**
   * Checks if current pathname matches the status route
   * Handles various pathname formats that Expo Router might use
   * 
   * @param pathname - Current pathname from usePathname()
   * @returns true if pathname matches status route
   */
  isStatusRoute: (pathname: string | null | undefined): boolean => {
    if (!pathname) return false;
    return (
      pathname === ROUTES.STATUS ||
      pathname === '/status' ||
      pathname.endsWith('/status') ||
      ROUTE_PATTERNS.STATUS.test(pathname)
    );
  },

  /**
   * Checks if current pathname matches the settings route
   * 
   * @param pathname - Current pathname from usePathname()
   * @returns true if pathname matches settings route
   */
  isSettingsRoute: (pathname: string | null | undefined): boolean => {
    if (!pathname) return false;
    return ROUTE_PATTERNS.SETTINGS.test(pathname);
  },

  /**
   * Checks if current pathname matches the home route
   * 
   * @param pathname - Current pathname from usePathname()
   * @returns true if pathname matches home route
   */
  isHomeRoute: (pathname: string | null | undefined): boolean => {
    if (!pathname) return false;
    return pathname === '/' || pathname === '';
  },

  /**
   * Checks if current pathname matches a conversation route
   * 
   * @param pathname - Current pathname from usePathname()
   * @returns true if pathname matches conversation route pattern
   */
  isConversationRoute: (pathname: string | null | undefined): boolean => {
    if (!pathname) return false;
    return ROUTE_PATTERNS.CONVERSATION.test(pathname);
  },

  /**
   * Checks if current pathname matches a profile route
   * 
   * @param pathname - Current pathname from usePathname()
   * @returns true if pathname matches profile route pattern
   */
  isProfileRoute: (pathname: string | null | undefined): boolean => {
    if (!pathname) return false;
    return ROUTE_PATTERNS.PROFILE.test(pathname);
  },
};

