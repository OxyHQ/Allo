/**
 * Conversation helper utilities
 */

import { Conversation } from '@/app/(chat)/index';

/**
 * Get conversation ID from multiple sources (prop > pathname > segments)
 */
export function getConversationId(
  propId?: string,
  pathname?: string | null,
  segments?: (string | undefined)[]
): string | undefined {
  if (propId) return propId;
  
  const pathMatch = pathname?.match(/\/c\/([^/?]+)/);
  if (pathMatch?.[1]) return pathMatch[1];
  
  const cIndex = segments?.indexOf('c');
  if (cIndex !== undefined && cIndex !== -1 && cIndex < (segments?.length ?? 0) - 1) {
    const id = segments?.[cIndex + 1];
    if (id && id !== 'c') return id;
  }
  
  return undefined;
}

/**
 * Get sender's first name from conversation participants
 */
export function getSenderNameFromParticipants(
  senderId: string,
  conversation: Conversation | null
): string | undefined {
  const participant = conversation?.participants?.find(p => p.id === senderId);
  return participant?.name?.first;
}

