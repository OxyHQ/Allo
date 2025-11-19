import { Conversation } from '@/app/(chat)/index';
import { useOxy } from '@oxyhq/services';
import { useUserById } from '@/stores/usersStore';

/**
 * Get the URL route for a conversation
 * - Direct conversations: /u/:id
 * - Group/other conversations: /c/[id]
 */
export function getConversationRoute(
  conversation: Conversation,
  currentUserId?: string
): string {
  // For direct conversations, use /u/:id
  if (conversation.type === 'direct') {
    // Get the other participant's ID
    const otherParticipant = conversation.participants?.find(
      p => p.id !== currentUserId
    );
    
    if (otherParticipant?.id) {
      return `/u/${otherParticipant.id}`;
    }
    
    // Fallback to /c/[id] if ID not available
    return `/c/${conversation.id}`;
  }
  
  // For groups and other types, use /c/[id]
  return `/c/${conversation.id}`;
}

/**
 * Hook to get conversation route using Oxy user data
 */
export function useConversationRoute(conversation: Conversation | null): string | null {
  const { user } = useOxy();
  const currentUserId = user?.id;
  
  if (!conversation) return null;
  
  // For direct conversations, try to get username from Oxy
  if (conversation.type === 'direct') {
    const otherParticipant = conversation.participants?.find(
      p => p.id !== currentUserId
    );
    
    // First try participant data
    if (otherParticipant?.username) {
      return `/@${otherParticipant.username}`;
    }
    
    // Try to get from Oxy user data
    if (otherParticipant?.id) {
      const user = useUserById(otherParticipant.id);
      if (user?.username || user?.handle) {
        return `/@${user.username || user.handle}`;
      }
    }
    
    // Fallback to /c/[id]
    return `/c/${conversation.id}`;
  }
  
  // For groups and other types, use /c/[id]
  return `/c/${conversation.id}`;
}


