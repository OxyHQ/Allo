/**
 * Conversation helper utilities
 */

import { Conversation } from '@/app/(chat)/index';
import { useUserById } from '@/stores/usersStore';
import { useOxy } from '@oxyhq/services';

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
    const username = segments[atIndex]?.substring(1);
    if (username) return `@${username}`;
  }
  
  return undefined;
}

/**
 * Get sender's name from conversation participants or Oxy user data
 * This is a hook that should be used in components
 */
export function useSenderName(
  senderId: string | undefined,
  conversation: Conversation | null
): string | undefined {
  const { user: currentUser } = useOxy();
  const user = useUserById(senderId);

  // First try to get from participant data
  const participant = conversation?.participants?.find(p => p.id === senderId);
  if (participant?.name?.first) {
    return participant.name.first;
  }

  // If it's the current user, use current user data
  if (senderId === currentUser?.id) {
    if (typeof currentUser.name === 'string') {
      return currentUser.name.split(' ')[0];
    }
    return currentUser.name?.first || currentUser.username;
  }

  // Otherwise, use fetched user data from Oxy
  if (!user) return undefined;

  if (typeof user.name === 'string') {
    return user.name.split(' ')[0];
  }

  return user.name?.first || user.username || user.handle;
}

/**
 * Get sender's full name from conversation participants or Oxy user data
 * This is a hook that should be used in components
 */
export function useSenderFullName(
  senderId: string | undefined,
  conversation: Conversation | null
): string | undefined {
  const { user: currentUser } = useOxy();
  const user = useUserById(senderId);

  // First try to get from participant data
  const participant = conversation?.participants?.find(p => p.id === senderId);
  if (participant?.name?.first) {
    const lastName = participant.name.last ? ` ${participant.name.last}` : '';
    return `${participant.name.first}${lastName}`;
  }

  // If it's the current user, use current user data
  if (senderId === currentUser?.id) {
    if (typeof currentUser.name === 'string') {
      return currentUser.name;
    }
    return currentUser.name?.full || currentUser.name?.first || currentUser.username;
  }

  // Otherwise, use fetched user data from Oxy
  if (!user) return undefined;

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
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use useSenderName hook instead
 */
export function getSenderNameFromParticipants(
  senderId: string,
  conversation: Conversation | null
): string | undefined {
  const participant = conversation?.participants?.find(p => p.id === senderId);
  return participant?.name?.first;
}

