import { useMemo } from 'react';

import { useConversationsStore } from '@/stores';
import { useMatrixConversations } from '@/hooks/useMatrixConversations';

/**
 * Hook to get conversation data by ID from the store
 *
 * @example
 * ```tsx
 * const conversation = useConversation('conv-1');
 * ```
 *
 * With the Matrix chat backend the conversation comes from the room list rather
 * than the store: a room is only ever known through sync, so there is nowhere
 * else to look it up. The store branch below is untouched, and is what a build
 * with `EXPO_PUBLIC_CHAT_BACKEND` unset still runs.
 */
export function useConversation(conversationId?: string | null) {
  const stored = useConversationsStore(state =>
    conversationId ? state.getConversation(conversationId) : null
  );
  const rooms = useMatrixConversations();

  return useMemo(() => {
    if (rooms === undefined) {
      return stored;
    }
    if (!conversationId) {
      return null;
    }
    // Undefined while sync has not delivered the room — a deep link into a
    // conversation the client has not seen yet is the ordinary way there.
    return rooms.find((room) => room.id === conversationId);
  }, [rooms, stored, conversationId]);
}
