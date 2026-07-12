import { Conversation, ConversationType, ConversationParticipant } from '@/app/(chat)/index';
import { useUserById, useUsersStore, type UserEntity } from '@/stores/usersStore';
import { useOxy } from '@oxyhq/services';
import { useEffect } from 'react';

/**
 * Resolves a cached Oxy user by id. Callers pass a resolver derived from a
 * reactive store subscription (see {@link useConversationDisplayName}) so display
 * names recompute when the user cache is enriched — the pure helpers below never
 * reach into `useUsersStore.getState()` themselves.
 */
type UserResolver = (id: string) => UserEntity | undefined;

/**
 * Render a cached user's canonical display name, falling back to
 * username/handle when the enriched name is absent.
 */
function displayNameFromCachedUser(cachedUser: UserEntity): string | undefined {
  if (typeof cachedUser.name === 'string') {
    return cachedUser.name;
  }
  if (cachedUser.name?.displayName) {
    return cachedUser.name.displayName;
  }
  if (cachedUser.username || cachedUser.handle) {
    return cachedUser.username || cachedUser.handle || '';
  }
  return undefined;
}

/**
 * Render the participant's canonical display name (Oxy `name.displayName`),
 * falling back to username/id only when the enriched name is absent.
 */
function getParticipantFullName(participant: ConversationParticipant, userId?: string): string {
  return participant.name?.displayName || participant.username || userId || '';
}

/**
 * Hook to get the participant's canonical display name using Oxy user data.
 */
export function useParticipantFullName(
  participant: ConversationParticipant | undefined
): string {
  const { user: currentUser } = useOxy();
  const user = useUserById(participant?.id);

  if (!participant) return '';

  // Prefer the canonical display name from cached Oxy user data.
  if (user) {
    if (typeof user.name === 'string') {
      return user.name;
    }
    if (user.name?.displayName) {
      return user.name.displayName;
    }
    if (user.username || user.handle) {
      return user.username || user.handle || '';
    }
  }

  // Fallback to the participant's backend-enriched display name.
  if (participant.name?.displayName) {
    return participant.name.displayName;
  }

  // If it's the current user, render the API's canonical display name.
  if (participant.id === currentUser?.id) {
    return currentUser.name?.displayName || currentUser.username || '';
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
  currentUserId: string | undefined,
  getUser: UserResolver,
  maxNames: number = 2
): string {
  // Filter out current user if provided
  const otherParticipants = currentUserId
    ? participants.filter(p => p.id !== currentUserId)
    : participants;

  if (otherParticipants.length === 0) {
    return '';
  }

  // Render the canonical display name from the resolved cache, falling back to enrichment.
  const getParticipantDisplayName = (p: ConversationParticipant): string => {
    const cachedUser = getUser(p.id);
    const cachedName = cachedUser ? displayNameFromCachedUser(cachedUser) : undefined;
    if (cachedName) {
      return cachedName;
    }

    // Fallback to the participant's backend-enriched display name.
    return p.name?.displayName || p.username || p.id || 'Unknown';
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
  currentUserId: string | undefined,
  getUser: UserResolver
): string {
  if (conversation.type === 'direct') {
    // For direct conversations, resolve the other participant's Oxy user.
    const otherParticipant = conversation.participants?.find(p => p.id !== currentUserId);
    if (otherParticipant) {
      // Render the canonical display name from the resolved cache.
      const cachedUser = getUser(otherParticipant.id);
      const cachedName = cachedUser ? displayNameFromCachedUser(cachedUser) : undefined;
      if (cachedName) {
        return cachedName;
      }

      // Fallback to the participant's backend-enriched display name.
      if (otherParticipant.name?.displayName) {
        return otherParticipant.name.displayName;
      }
      if (otherParticipant.username) {
        return otherParticipant.username;
      }
    }

    // Return conversation name as-is (fallback if no participant data)
    return conversation.name || '';
  }

  // For groups, prefer groupName if available
  if (conversation.groupName) {
    return conversation.groupName;
  }

  // Otherwise generate from participants (using the resolved cache)
  if (conversation.participants && conversation.participants.length > 0) {
    return generateGroupName(conversation.participants, currentUserId, getUser);
  }

  return conversation.name || '';
}

/**
 * Reactive display name for a conversation.
 *
 * Subscribes to the users store via a Zustand selector that returns a primitive
 * string, so the name recomputes whenever the participant user cache is enriched
 * (e.g. after `useRealtimeMessaging` writes fetched users into the store). Because
 * the value flows out of a live store subscription (`useSyncExternalStore` under
 * the hood) rather than a one-shot `getState()` read in render, the React Compiler
 * treats it as reactive state and can never freeze it on a stale first value.
 *
 * The selector reads only the participant ids this conversation needs, so an
 * unrelated user landing in the cache produces the same string and skips a
 * re-render (Zustand's default `Object.is` equality on the primitive result).
 */
export function useConversationDisplayName(
  conversation: Conversation | null | undefined,
  currentUserId?: string
): string {
  return useUsersStore((state) =>
    conversation
      ? getConversationDisplayName(
          conversation,
          currentUserId,
          (id) => state.usersById[id]?.data
        )
      : ''
  );
}

/**
 * Get participants for display (excluding current user)
 * @param conversation Conversation object
 * @param currentUserId Current user's ID
 * @returns Array of participants excluding current user
 */
export function getOtherParticipants(
  conversation: Pick<Conversation, 'participants'>,
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
interface FileUrlResolver {
  getFileDownloadUrl(fileId: string, variant?: string): string;
}

export function getConversationAvatar(
  conversation: Conversation,
  currentUserId?: string,
  oxyServices?: FileUrlResolver
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
      console.warn('[conversationUtils] getConversationAvatar: failed to resolve file URL, returning original', e);
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
        usersStore.ensureById(otherUserId, (id) => oxyServices.getUserById(id));
      }
    }
  }, [otherParticipant?.username, otherUserId, user, usersStore]);

  // Render the canonical display name from Oxy user data, then fall back.
  let name: string | undefined;

  if (user) {
    if (typeof user.name === 'string') {
      name = user.name;
    } else if (user.name?.displayName) {
      name = user.name.displayName;
    } else {
      name = user.username || user.handle;
    }
  }

  const username = user?.username || user?.handle || otherParticipant?.username;

  if (!name && otherParticipant) {
    name = otherParticipant.name?.displayName || otherParticipant.username;
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

