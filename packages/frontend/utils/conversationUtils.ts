import { Conversation, ConversationType, ConversationParticipant } from '@/app/(chat)/index';

/**
 * Get full name from participant (name.first + name.last)
 */
function getParticipantFullName(participant: ConversationParticipant): string {
  const { first, last } = participant.name;
  return `${first}${last ? ` ${last}` : ''}`.trim();
}

/**
 * Generate a group conversation name from participant names
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
    return 'Empty Group';
  }

  if (otherParticipants.length === 1) {
    return getParticipantFullName(otherParticipants[0]);
  }

  // Take first maxNames participants
  const namesToShow = otherParticipants.slice(0, maxNames).map(getParticipantFullName);
  const remainingCount = otherParticipants.length - maxNames;

  if (remainingCount > 0) {
    return `${namesToShow.join(', ')} and ${remainingCount} other${remainingCount > 1 ? 's' : ''}`;
  }

  return namesToShow.join(', ');
}

/**
 * Get the display name for a conversation
 * @param conversation Conversation object
 * @param currentUserId Current user's ID
 * @returns Display name
 */
export function getConversationDisplayName(
  conversation: Conversation,
  currentUserId?: string
): string {
  if (conversation.type === 'direct') {
    return conversation.name;
  }

  // For groups, prefer groupName if available
  if (conversation.groupName) {
    return conversation.groupName;
  }

  // Otherwise generate from participants
  if (conversation.participants && conversation.participants.length > 0) {
    return generateGroupName(conversation.participants, currentUserId);
  }

  return conversation.name || 'Group Conversation';
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
  currentUserId?: string
): string | undefined {
  // For direct conversations, return avatar directly
  if (conversation.type === 'direct') {
    return conversation.avatar;
  }

  // For groups, prefer groupAvatar if available
  if (conversation.groupAvatar) {
    return conversation.groupAvatar;
  }

  // Otherwise use the first participant's avatar
  if (conversation.participants && conversation.participants.length > 0) {
    const otherParticipants = getOtherParticipants(conversation, currentUserId);
    return otherParticipants[0]?.avatar || conversation.avatar;
  }

  return conversation.avatar;
}

/**
 * Check if conversation is a group
 * @param conversation Conversation object
 * @returns True if group conversation
 */
export function isGroupConversation(conversation: Conversation): boolean {
  return conversation.type === 'group';
}

