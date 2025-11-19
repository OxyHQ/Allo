import { Conversation, ConversationType, ConversationParticipant } from '@/app/(chat)/index';
import { useUserById, useUsersStore } from '@/stores/usersStore';
import { useOxy, OxyServices } from '@oxyhq/services';
import { useEffect } from 'react';

// Import useUsersStore for direct access in non-hook functions
const getUsersStore = () => useUsersStore.getState();

/**
 * Get full name from participant (name.first + name.last)
 * Falls back to Oxy user data if participant data is incomplete
 */
function getParticipantFullName(participant: ConversationParticipant, userId?: string): string {
  const { first, last } = participant.name;
  if (first) {
    return `${first}${last ? ` ${last}` : ''}`.trim();
  }
  // If participant data is incomplete, this will be handled by hooks that use Oxy
  return participant.username || userId || '';
}

/**
 * Hook to get participant full name using Oxy user data
 */
export function useParticipantFullName(
  participant: ConversationParticipant | undefined
): string {
  const { user: currentUser } = useOxy();
  const user = useUserById(participant?.id);

  if (!participant) return '';

  // First try to get from usersStore (Oxy user data)
  if (user) {
    if (typeof user.name === 'string') {
      return user.name;
    }
    if (user.name?.full) {
      return user.name.full;
    }
    if (user.name?.first) {
      const lastName = user.name.last ? ` ${user.name.last}` : '';
      return `${user.name.first}${lastName}`.trim();
    }
    if (user.username || user.handle) {
      return user.username || user.handle || '';
    }
  }

  // Fallback to participant data
  if (participant.name?.first) {
    const lastName = participant.name.last ? ` ${participant.name.last}` : '';
    return `${participant.name.first}${lastName}`.trim();
  }

  // If it's the current user, use current user data
  if (participant.id === currentUser?.id) {
    if (typeof currentUser.name === 'string') {
      return currentUser.name;
    }
    return currentUser.name?.full || currentUser.name?.first || currentUser.username || '';
  }

  return participant.username || participant.id || '';
}

/**
 * Generate a group conversation name from participant names
 * Uses zustand cache efficiently (like WhatsApp)
 * @param participants Array of participants (excluding current user)
 * @param currentUserId Current user's ID to exclude from name generation
 * @param maxNames Maximum number of names to include (default: 2)
 * @returns Generated group name
 */
export function generateGroupName(
  participants: ConversationParticipant[],
  currentUserId?: string,
  maxNames: number = 2
): string {
  // Filter out current user if provided
  const otherParticipants = currentUserId
    ? participants.filter(p => p.id !== currentUserId)
    : participants;

  if (otherParticipants.length === 0) {
    return '';
  }

  const usersStore = getUsersStore();

  // Helper to get name from zustand cache or participant data
  const getParticipantDisplayName = (p: ConversationParticipant): string => {
    // Try zustand cache first (efficient)
    const cachedUser = usersStore.getCachedById(p.id);
    if (cachedUser) {
      if (typeof cachedUser.name === 'string') {
        return cachedUser.name;
      }
      if (cachedUser.name?.full) {
        return cachedUser.name.full;
      }
      if (cachedUser.name?.first) {
        const lastName = cachedUser.name.last ? ` ${cachedUser.name.last}` : '';
        return `${cachedUser.name.first}${lastName}`.trim();
      }
      if (cachedUser.username || cachedUser.handle) {
        return cachedUser.username || cachedUser.handle || '';
      }
    }
    
    // Fallback to participant data (from backend enrichment)
    if (p.name?.first) {
      const lastName = p.name.last ? ` ${p.name.last}` : '';
      return `${p.name.first}${lastName}`.trim();
    }
    return p.username || p.id || 'Unknown';
  };

  if (otherParticipants.length === 1) {
    return getParticipantDisplayName(otherParticipants[0]);
  }

  // Take first maxNames participants
  const namesToShow = otherParticipants.slice(0, maxNames).map(getParticipantDisplayName);
  const remainingCount = otherParticipants.length - maxNames;

  if (remainingCount > 0) {
    return `${namesToShow.join(', ')} and ${remainingCount} other${remainingCount > 1 ? 's' : ''}`;
  }

  return namesToShow.join(', ');
}

/**
 * Get the display name for a conversation
 * Uses zustand cache efficiently (like WhatsApp)
 * @param conversation Conversation object
 * @param currentUserId Current user's ID
 * @returns Display name
 */
export function getConversationDisplayName(
  conversation: Conversation,
  currentUserId?: string
): string {
  if (conversation.type === 'direct') {
    // For direct conversations, get name from zustand cache (backend already enriched with Oxy data)
    const otherParticipant = conversation.participants?.find(p => p.id !== currentUserId);
    if (otherParticipant) {
      // Try zustand cache first (efficient)
      const cachedUser = useUsersStore.getState().getCachedById(otherParticipant.id);
      if (cachedUser) {
        if (typeof cachedUser.name === 'string') {
          return cachedUser.name;
        }
        if (cachedUser.name?.full) {
          return cachedUser.name.full;
        }
        if (cachedUser.name?.first) {
          const lastName = cachedUser.name.last ? ` ${cachedUser.name.last}` : '';
          return `${cachedUser.name.first}${lastName}`.trim();
        }
        if (cachedUser.username || cachedUser.handle) {
          return cachedUser.username || cachedUser.handle || '';
        }
      }
      
      // Fallback to participant data (from backend enrichment)
      if (otherParticipant.name?.first) {
        const lastName = otherParticipant.name.last ? ` ${otherParticipant.name.last}` : '';
        return `${otherParticipant.name.first}${lastName}`.trim();
      }
      if (otherParticipant.username) {
        return otherParticipant.username;
      }
    }
    
    // Filter out generic "Direct Chat" name
    if (conversation.name === 'Direct Chat') {
      return '';
    }
    return conversation.name || '';
  }

  // For groups, prefer groupName if available
  if (conversation.groupName) {
    return conversation.groupName;
  }

  // Otherwise generate from participants (using zustand cache)
  if (conversation.participants && conversation.participants.length > 0) {
    return generateGroupName(conversation.participants, currentUserId);
  }

  return conversation.name || '';
}

/**
 * Get participants for display (excluding current user)
 * @param conversation Conversation object
 * @param currentUserId Current user's ID
 * @returns Array of participants excluding current user
 */
export function getOtherParticipants(
  conversation: Conversation,
  currentUserId?: string
): ConversationParticipant[] {
  if (!conversation.participants) {
    return [];
  }

  if (!currentUserId) {
    return conversation.participants;
  }

  return conversation.participants.filter(p => p.id !== currentUserId);
}

/**
 * Get participant count for display
 * @param conversation Conversation object
 * @param currentUserId Current user's ID
 * @returns Participant count excluding current user
 */
export function getParticipantCount(
  conversation: Conversation,
  currentUserId?: string
): number {
  if (conversation.type === 'direct') {
    return 1;
  }

  if (conversation.participantCount !== undefined) {
    return conversation.participantCount;
  }

  if (!conversation.participants) {
    return 0;
  }

  const otherParticipants = getOtherParticipants(conversation, currentUserId);
  return otherParticipants.length;
}

/**
 * Get the avatar URL for a conversation
 * @param conversation Conversation object
 * @param currentUserId Current user's ID
 * @returns Avatar URL or undefined
 */
export function getConversationAvatar(
  conversation: Conversation,
  currentUserId?: string,
  oxyServices?: OxyServices
): string | undefined {
  let avatar: string | undefined;

  // For direct conversations, return avatar directly
  if (conversation.type === 'direct') {
    avatar = conversation.avatar;
  } else if (conversation.groupAvatar) {
    // For groups, prefer groupAvatar if available
    avatar = conversation.groupAvatar;
  } else if (conversation.participants && conversation.participants.length > 0) {
    // Otherwise use the first participant's avatar
    const otherParticipants = getOtherParticipants(conversation, currentUserId);
    avatar = otherParticipants[0]?.avatar || conversation.avatar;
  } else {
    avatar = conversation.avatar;
  }

  // If we have an avatar and oxyServices, try to get the URL if it's an ID (not a URL)
  if (avatar && oxyServices && !avatar.startsWith('http') && !avatar.startsWith('file://')) {
    try {
      return oxyServices.getFileDownloadUrl(avatar, 'thumb');
    } catch (e) {
      // Ignore error and return original
    }
  }

  return avatar;
}

/**
 * Check if conversation is a group
 * @param conversation Conversation object
 * @returns True if group conversation
 */
export function isGroupConversation(conversation: Conversation): boolean {
  return conversation.type === 'group';
}

/**
 * Hook to get contact information for a direct conversation using Oxy user data
 * @param conversation Conversation object
 * @param currentUserId Current user's ID
 * @returns Contact info or null
 */
export function useContactInfo(conversation: Conversation | null, currentUserId?: string) {
  const { user: currentUser, oxyServices } = useOxy();
  const usersStore = useUsersStore();
  
  if (!conversation || conversation.type !== 'direct') return null;

  // Get the other participant (not current user)
  const otherParticipant = conversation.participants?.find(p => p.id !== currentUserId);
  const otherUserId = otherParticipant?.id;
  const user = useUserById(otherUserId);

  // Fetch user if missing and we have a username or ID
  useEffect(() => {
    if (!user) {
      if (otherParticipant?.username) {
        usersStore.ensureByUsername(otherParticipant.username, (u) => oxyServices.getProfileByUsername(u));
      } else if (otherUserId) {
        // Try fetching by ID using getProfileByUsername as it might support IDs based on docs
        usersStore.ensureById(otherUserId, (id) => oxyServices.getProfileByUsername(id));
      }
    }
  }, [otherParticipant?.username, otherUserId, user, usersStore]);

  // Use Oxy user data first, then fall back to participant data
  let name: string | undefined;
  
  if (user) {
    if (typeof user.name === 'string') {
      name = user.name;
    } else if (user.name?.full) {
      name = user.name.full;
    } else if (user.name?.first) {
      name = `${user.name.first}${user.name.last ? ` ${user.name.last}` : ''}`.trim();
    } else {
      name = user.username || user.handle;
    }
  }

  const username = user?.username || user?.handle || otherParticipant?.username;

  if (!name && otherParticipant) {
    if (otherParticipant.name?.first) {
      name = `${otherParticipant.name.first}${otherParticipant.name.last ? ` ${otherParticipant.name.last}` : ''}`.trim();
    } else {
      name = otherParticipant.username;
    }
  }

  if (!name) {
    // Avoid using generic "Direct Chat" if possible
    if (conversation.name && conversation.name !== 'Direct Chat') {
      name = conversation.name;
    } else {
      // If we have no name, use username or handle
      name = username || '';
    }
  }

  let avatar = user?.avatar || otherParticipant?.avatar || conversation.avatar;
  
  // Convert avatar ID to URL using oxyServices if needed
  if (avatar && oxyServices && !avatar.startsWith('http') && !avatar.startsWith('file://')) {
    try {
      avatar = oxyServices.getFileDownloadUrl(avatar, 'thumb');
    } catch (e) {
      // Ignore error and keep original avatar
    }
  }

  return {
    name,
    username,
    avatar,
    isOnline: false, // Would come from participant data or presence system
    lastSeen: new Date(), // Would come from participant data
  };
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use useContactInfo hook instead
 */
export function getContactInfo(conversation: Conversation | null) {
  if (!conversation) return null;

  if (conversation.type === 'direct') {
    // For direct conversations, get the other participant
    // In a real app, this would be from the participants array excluding current user
    return {
      name: conversation.name,
      username: '@username', // Would come from participant data
      avatar: conversation.avatar,
      isOnline: false, // Would come from participant data
      lastSeen: new Date(), // Would come from participant data
    };
  }

  return null;
}

/**
 * Get group information for a group conversation
 * @param conversation Conversation object
 * @returns Group info or null
 */
export function getGroupInfo(conversation: Conversation | null) {
  if (!conversation || conversation.type !== 'group') return null;

  return {
    name: conversation.groupName || conversation.name,
    avatar: conversation.groupAvatar || conversation.avatar,
    participants: conversation.participants || [],
    participantCount: conversation.participantCount || (conversation.participants?.length || 0),
  };
}

