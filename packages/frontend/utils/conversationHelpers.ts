/**
 * Helper utilities for conversation view
 * Extracted for reusability and testability
 */

import { Conversation } from '@/app/(chat)/index';

/**
 * Extract conversation ID from pathname
 * Handles various pathname formats from Expo Router
 */
export function extractConversationId(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  const match = pathname.match(/\/c\/([^/?]+)/);
  return match?.[1] || null;
}

/**
 * Extract conversation ID from segments
 * More reliable for dynamic routes
 */
export function extractConversationIdFromSegments(segments: (string | undefined)[]): string | null {
  if (segments.length === 0) return null;
  
  const lastSegment = segments[segments.length - 1];
  if (lastSegment === 'c') return null;
  
  const cIndex = segments.indexOf('c');
  if (cIndex === -1 || cIndex === segments.length - 1) return null;
  
  return segments[cIndex + 1] || null;
}

/**
 * Get the best conversation ID from multiple sources
 * Prioritizes prop > pathname > segments
 */
export function getConversationId(
  propId?: string,
  pathname?: string | null,
  segments?: (string | undefined)[]
): string | undefined {
  return propId || extractConversationId(pathname) || extractConversationIdFromSegments(segments || []) || undefined;
}

/**
 * Extract first name from full name
 * Used for displaying sender names in group conversations
 */
export function getFirstName(fullName: string): string {
  const parts = fullName.trim().split(/\s+/);
  return parts[0] || fullName;
}

/**
 * Get sender name from conversation participants
 */
export function getSenderNameFromParticipants(
  senderId: string,
  conversation: Conversation | null,
  currentUserId: string
): string | undefined {
  if (!conversation?.participants) return undefined;
  
  const participant = conversation.participants.find(p => p.id === senderId);
  if (!participant) return undefined;
  
  return getFirstName(participant.name);
}

