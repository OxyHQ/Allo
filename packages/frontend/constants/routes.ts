/**
 * Route constants for the application
 * Centralized route definitions following Expo Router 54 conventions
 */

export const ROUTE_CONSTANTS = {
  // Root routes
  HOME: '/',
  
  // Chat routes (group: (chat))
  CHAT_INDEX: '/(chat)',
  STATUS: '/(chat)/status',
  SETTINGS: '/(chat)/settings',
  
  // Conversation routes
  CONVERSATION: (id: string) => `/c/${id}`,
  
  // Other routes
  CALLS: '/calls',
  
  // Profile routes
  PROFILE: (username: string) => `/@${username}`,
} as const;

/**
 * Route path patterns for matching
 */
export const ROUTE_PATTERNS = {
  CONVERSATION: /^\/c\/([^/]+)$/,
  PROFILE: /^\/@([^/]+)$/,
  SETTINGS: /\/settings/,
  STATUS: /\/status/,
} as const;


