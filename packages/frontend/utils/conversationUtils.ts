import { useOxy } from '@oxy.so/services';

import type { Conversation, ConversationParticipant } from '@/lib/chat/model';
import { usePerson } from '@/hooks/usePerson';
import { useUsersStore, type UserEntity } from '@/stores/usersStore';

/**
 * Resolves a cached Oxy user by id. Callers pass a resolver derived from a
 * reactive store subscription (see {@link useConversationDisplayName}) so display
 * names recompute when the user cache is enriched — the pure helpers below never
 * reach into `useUsersStore.getState()` themselves.
 *
 * The cache is filled by `lib/allo/people.ts`; nothing here fetches.
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
 * Hook to get the participant's canonical display name using Oxy user data.
 * `''` for a participant still being looked up: a caller draws nothing.
 */
export function useParticipantFullName(
  participant: ConversationParticipant | undefined
): string {
  const { user: currentUser } = useOxy();
  const person = usePerson(participant?.id);

  if (!participant) return '';
  if (person) return person.displayName;
  if (participant.name?.displayName) return participant.name.displayName;
  if (participant.id === currentUser?.id) {
    return currentUser.name?.displayName || currentUser.username || '';
  }
  return participant.username || '';
}

/**
 * Generate a group conversation name from participant names
 * @param participants Array of participants (excluding current user)
 * @param currentUserId Current user's ID to exclude from name generation
 * @param maxNames Maximum number of names to include (default: 2)
 * @returns Generated group name, or `''` while nobody in it can be named yet
 */
export function generateGroupName(
  participants: ConversationParticipant[],
  currentUserId: string | undefined,
  getUser: UserResolver,
  maxNames: number = 2
): string {
  const otherParticipants = currentUserId
    ? participants.filter(p => p.id !== currentUserId)
    : participants;

  if (otherParticipants.length === 0) {
    return '';
  }

  // Never the id: a participant nobody can name yet contributes nothing, and
  // the name is composed from those who can be.
  const named = otherParticipants
    .map((p) => {
      const cachedUser = getUser(p.id);
      return (cachedUser ? displayNameFromCachedUser(cachedUser) : undefined) || p.name?.displayName || p.username;
    })
    .filter((name): name is string => Boolean(name));

  if (named.length === 0) return '';
  if (named.length === 1 && otherParticipants.length === 1) return named[0];

  const namesToShow = named.slice(0, maxNames);
  const remainingCount = otherParticipants.length - namesToShow.length;

  if (remainingCount > 0) {
    return `${namesToShow.join(', ')} and ${remainingCount} other${remainingCount > 1 ? 's' : ''}`;
  }

  return namesToShow.join(', ');
}

/**
 * Get the display name for a conversation
 * @param conversation Conversation object
 * @param currentUserId Current user's ID
 * @returns Display name, or `''` while it cannot be named yet
 */
export function getConversationDisplayName(
  conversation: Conversation,
  currentUserId: string | undefined,
  getUser: UserResolver
): string {
  if (conversation.type === 'direct') {
    const otherParticipant = conversation.participants.find(p => p.id !== currentUserId);
    if (otherParticipant) {
      const cachedUser = getUser(otherParticipant.id);
      const cachedName = cachedUser ? displayNameFromCachedUser(cachedUser) : undefined;
      if (cachedName) {
        return cachedName;
      }
      if (otherParticipant.name?.displayName) {
        return otherParticipant.name.displayName;
      }
      if (otherParticipant.username) {
        return otherParticipant.username;
      }
    }
    return conversation.name || '';
  }

  // For groups, prefer the title when one has been set
  if (conversation.groupName) {
    return conversation.groupName;
  }

  if (conversation.participants.length > 0) {
    return generateGroupName(conversation.participants, currentUserId, getUser);
  }

  return conversation.name || '';
}

/**
 * Reactive display name for a conversation.
 *
 * Subscribes to the users store via a Zustand selector that returns a primitive
 * string, so the name recomputes whenever the participant user cache is enriched
 * (the people layer writes fetched users into the store). Because the value
 * flows out of a live store subscription rather than a one-shot `getState()`
 * read in render, the React Compiler treats it as reactive state.
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

  return getOtherParticipants(conversation, currentUserId).length;
}

interface FileUrlResolver {
  getFileDownloadUrl(fileId: string, variant?: string): string;
}

/**
 * Get the avatar URL for a conversation
 */
export function getConversationAvatar(
  conversation: Conversation,
  currentUserId?: string,
  oxyServices?: FileUrlResolver,
  getUser?: UserResolver
): string | undefined {
  let avatar: string | undefined;

  if (conversation.type === 'direct') {
    const other = conversation.participants.find((p) => p.id !== currentUserId);
    avatar = (other && getUser?.(other.id)?.avatar) || other?.avatar || conversation.avatar;
  } else if (conversation.groupAvatar) {
    avatar = conversation.groupAvatar;
  } else if (conversation.participants.length > 0) {
    const otherParticipants = getOtherParticipants(conversation, currentUserId);
    const first = otherParticipants[0];
    avatar = (first && getUser?.(first.id)?.avatar) || first?.avatar || conversation.avatar;
  } else {
    avatar = conversation.avatar;
  }

  if (avatar && oxyServices && !avatar.startsWith('http') && !avatar.startsWith('file://')) {
    try {
      return oxyServices.getFileDownloadUrl(avatar, 'thumb');
    } catch (e) {
      console.warn('[conversationUtils] getConversationAvatar: failed to resolve file URL, returning original', e);
    }
  }

  return avatar;
}

/** Reactive avatar for a conversation row: re-renders when the people cache fills. */
export function useConversationAvatar(
  conversation: Conversation | null | undefined,
  currentUserId?: string
): string | undefined {
  const { oxyServices } = useOxy();
  return useUsersStore((state) =>
    conversation
      ? getConversationAvatar(conversation, currentUserId, oxyServices, (id) => state.usersById[id]?.data)
      : undefined
  );
}

/**
 * Check if conversation is a group
 */
export function isGroupConversation(conversation: Conversation): boolean {
  return conversation.type === 'group';
}

/**
 * Hook to get contact information for a direct conversation using Oxy user data
 * @returns Contact info, or `null` for a group
 */
export function useContactInfo(conversation: Conversation | null, currentUserId?: string) {
  const { oxyServices } = useOxy();
  const otherParticipant =
    conversation?.type === 'direct' ? conversation.participants.find((p) => p.id !== currentUserId) : undefined;
  const person = usePerson(otherParticipant?.id);

  if (!conversation || conversation.type !== 'direct') return null;

  const name = person?.displayName || otherParticipant?.name?.displayName || otherParticipant?.username || '';
  const username = person?.handle || otherParticipant?.username;

  let avatar = person?.avatar || otherParticipant?.avatar || conversation.avatar;
  if (avatar && !avatar.startsWith('http') && !avatar.startsWith('file://')) {
    try {
      avatar = oxyServices.getFileDownloadUrl(avatar, 'thumb');
    } catch {
      // keep the id; a broken image is better than a hidden one
    }
  }

  return {
    name,
    username,
    avatar,
    isOnline: false, // Presence is not part of the platform yet
    lastSeen: new Date(),
  };
}

/**
 * The static half of {@link useContactInfo}, for a caller outside React.
 */
export function getContactInfo(conversation: Conversation | null) {
  if (!conversation) return null;

  if (conversation.type === 'direct') {
    return {
      name: conversation.name,
      username: undefined as string | undefined,
      avatar: conversation.avatar,
      isOnline: false,
      lastSeen: new Date(),
    };
  }

  return null;
}

/**
 * Get group information for a group conversation
 */
export function getGroupInfo(conversation: Conversation | null) {
  if (!conversation || conversation.type !== 'group') return null;

  return {
    name: conversation.groupName || conversation.name,
    avatar: conversation.groupAvatar || conversation.avatar,
    participants: conversation.participants,
    participantCount: conversation.participantCount || conversation.participants.length,
  };
}
