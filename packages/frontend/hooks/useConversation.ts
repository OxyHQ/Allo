import { useConversationsStore } from '@/stores';

/**
 * Hook to get conversation data by ID from the store
 * 
 * @example
 * ```tsx
 * const conversation = useConversation('conv-1');
 * ```
 */
export function useConversation(conversationId?: string | null) {
  return useConversationsStore(state => 
    conversationId ? state.getConversation(conversationId) : null
  );
}

