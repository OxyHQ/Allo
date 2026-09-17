/**
 * Conversation helper utilities
 */

/**
 * Get conversation ID from multiple sources (prop > pathname > segments)
 * Also handles /@username routes by finding the conversation
 */
export function getConversationId(
  propId?: string,
  pathname?: string | null,
  segments?: (string | undefined)[]
): string | undefined {
  if (propId) return propId;

  // Check for /c/[id] format
  const pathMatch = pathname?.match(/\/c\/([^/?]+)/);
  if (pathMatch?.[1]) return pathMatch[1];

  // Check for /@username format
  const usernameMatch = pathname?.match(/\/@([^/?]+)/);
  if (usernameMatch?.[1]) {
    // Return the username as a special identifier
    // The route handler will resolve this to a conversation ID
    return `@${usernameMatch[1]}`;
  }

  const cIndex = segments?.indexOf('c');
  if (cIndex !== undefined && cIndex !== -1 && cIndex < (segments?.length ?? 0) - 1) {
    const id = segments?.[cIndex + 1];
    if (id && id !== 'c') return id;
  }

  // Check for @username in segments
  const atIndex = segments?.findIndex(s => s?.startsWith('@'));
  if (atIndex !== undefined && atIndex !== -1) {
    const username = segments?.[atIndex]?.substring(1);
    if (username) return `@${username}`;
  }

  return undefined;
}
