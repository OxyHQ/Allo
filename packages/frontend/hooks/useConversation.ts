import { useState, useMemo } from 'react';
import { Conversation, ConversationParticipant, ConversationType } from '@/app/(chat)/index';

// Mock conversation store - replace with actual store/API
const MOCK_CONVERSATIONS: Conversation[] = [
  {
    id: '1',
    type: 'direct',
    name: 'John Doe',
    lastMessage: 'Hey, how are you?',
    timestamp: '2m ago',
    unreadCount: 2,
    avatar: undefined,
  },
  {
    id: '2',
    type: 'direct',
    name: 'Jane Smith',
    lastMessage: 'See you tomorrow!',
    timestamp: '1h ago',
    unreadCount: 0,
    avatar: undefined,
  },
  {
    id: '3',
    type: 'group',
    name: 'Team Chat',
    groupName: 'Team Chat',
    lastMessage: 'Thanks for the help!',
    timestamp: '3h ago',
    unreadCount: 5,
    participants: [
      { id: '1', name: 'John Doe', username: '@johndoe' },
      { id: '2', name: 'Jane Smith', username: '@janesmith' },
      { id: '3', name: 'Alice Johnson', username: '@alicej' },
      { id: '4', name: 'Bob Brown', username: '@bobbrown' },
    ],
    participantCount: 4,
    avatar: undefined,
  },
  {
    id: '4',
    type: 'group',
    name: 'Project Alpha',
    lastMessage: 'Let\'s meet tomorrow',
    timestamp: '5h ago',
    unreadCount: 0,
    participants: [
      { id: '1', name: 'John Doe', username: '@johndoe' },
      { id: '2', name: 'Jane Smith', username: '@janesmith' },
    ],
    participantCount: 2,
    avatar: undefined,
  },
];

/**
 * Hook to get conversation data by ID
 * Replace with actual API/store call
 */
export function useConversation(conversationId?: string | null) {
  const conversation = useMemo(() => {
    if (!conversationId) return null;
    return MOCK_CONVERSATIONS.find(c => c.id === conversationId) || null;
  }, [conversationId]);

  return conversation;
}

/**
 * Hook to get all conversations
 * Replace with actual API/store call
 */
export function useConversations() {
  const [conversations] = useState<Conversation[]>(MOCK_CONVERSATIONS);
  return conversations;
}

/**
 * Get contact information for a direct conversation
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

