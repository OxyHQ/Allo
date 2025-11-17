import { useState, useMemo } from 'react';
import { Conversation, ConversationParticipant, ConversationType } from '@/app/(chat)/index';

/**
 * Mock conversations data
 * Replace with actual API/store data in production
 */
const MOCK_CONVERSATIONS: Conversation[] = [
  // Direct conversations
  {
    id: '1',
    type: 'direct',
    name: 'Sarah Chen',
    lastMessage: 'Hey! Are we still on for lunch today?',
    timestamp: '2m ago',
    unreadCount: 2,
    avatar: 'https://i.pravatar.cc/150?img=1',
  },
  {
    id: '2',
    type: 'direct',
    name: 'Michael Rodriguez',
    lastMessage: 'Thanks for the help with the project!',
    timestamp: '15m ago',
    unreadCount: 0,
    avatar: 'https://i.pravatar.cc/150?img=5',
  },
  {
    id: '3',
    type: 'direct',
    name: 'Emily Watson',
    lastMessage: 'See you at the meeting tomorrow!',
    timestamp: '1h ago',
    unreadCount: 0,
    avatar: 'https://i.pravatar.cc/150?img=9',
  },
  {
    id: '4',
    type: 'direct',
    name: 'David Kim',
    lastMessage: 'The code review looks good to me 👍',
    timestamp: '3h ago',
    unreadCount: 1,
    avatar: 'https://i.pravatar.cc/150?img=12',
  },
  // Group conversations
  {
    id: '5',
    type: 'group',
    name: 'Design Team',
    groupName: 'Design Team',
    lastMessage: 'Jessica: Can everyone review the new mockups?',
    timestamp: '5m ago',
    unreadCount: 3,
    participants: [
      { id: 'current-user', name: 'You', username: '@you' },
      { id: '6', name: 'Jessica Martinez', username: '@jessicam', avatar: 'https://i.pravatar.cc/150?img=15' },
      { id: '7', name: 'Ryan Thompson', username: '@ryanth', avatar: 'https://i.pravatar.cc/150?img=20' },
      { id: '8', name: 'Sophie Anderson', username: '@sophiea', avatar: 'https://i.pravatar.cc/150?img=25' },
      { id: '9', name: 'Alex Park', username: '@alexp', avatar: 'https://i.pravatar.cc/150?img=30' },
    ],
    participantCount: 5,
    groupAvatar: undefined,
  },
  {
    id: '6',
    type: 'group',
    name: 'Weekend Plans',
    groupName: 'Weekend Plans',
    lastMessage: 'Lisa: Count me in for the hike!',
    timestamp: '1h ago',
    unreadCount: 0,
    participants: [
      { id: 'current-user', name: 'You', username: '@you' },
      { id: '10', name: 'Lisa Wang', username: '@lisaw', avatar: 'https://i.pravatar.cc/150?img=35' },
      { id: '11', name: 'Tom Wilson', username: '@tomw', avatar: 'https://i.pravatar.cc/150?img=40' },
      { id: '12', name: 'Maya Patel', username: '@mayap', avatar: 'https://i.pravatar.cc/150?img=45' },
    ],
    participantCount: 4,
    groupAvatar: undefined,
  },
  {
    id: '7',
    type: 'group',
    name: 'Family Group',
    groupName: 'Family',
    lastMessage: 'Mom: Don\'t forget about dinner this Sunday!',
    timestamp: '2h ago',
    unreadCount: 5,
    participants: [
      { id: 'current-user', name: 'You', username: '@you' },
      { id: '13', name: 'Mom', username: '@mom', avatar: 'https://i.pravatar.cc/150?img=50' },
      { id: '14', name: 'Dad', username: '@dad', avatar: 'https://i.pravatar.cc/150?img=55' },
      { id: '15', name: 'Emma', username: '@emma', avatar: 'https://i.pravatar.cc/150?img=60' },
      { id: '16', name: 'Jake', username: '@jake', avatar: 'https://i.pravatar.cc/150?img=65' },
    ],
    participantCount: 5,
    groupAvatar: undefined,
  },
  {
    id: '8',
    type: 'group',
    name: 'Project Alpha Team',
    groupName: 'Project Alpha',
    lastMessage: 'Daniel: Let\'s schedule a sync meeting',
    timestamp: '4h ago',
    unreadCount: 0,
    participants: [
      { id: 'current-user', name: 'You', username: '@you' },
      { id: '17', name: 'Daniel Lee', username: '@daniel', avatar: 'https://i.pravatar.cc/150?img=70' },
      { id: '18', name: 'Olivia Brown', username: '@olivia', avatar: 'https://i.pravatar.cc/150?img=75' },
    ],
    participantCount: 3,
    groupAvatar: undefined,
  },
  {
    id: '9',
    type: 'direct',
    name: 'Priya Sharma',
    lastMessage: 'Perfect! Looking forward to it 🎉',
    timestamp: '6h ago',
    unreadCount: 0,
    avatar: 'https://i.pravatar.cc/150?img=80',
  },
  {
    id: '10',
    type: 'group',
    name: 'Book Club',
    groupName: 'Monthly Book Club',
    lastMessage: 'Maria: Next month we\'re reading "The Seven Husbands"',
    timestamp: '1d ago',
    unreadCount: 2,
    participants: [
      { id: 'current-user', name: 'You', username: '@you' },
      { id: '19', name: 'Maria Garcia', username: '@mariag', avatar: 'https://i.pravatar.cc/150?img=85' },
      { id: '20', name: 'Kevin Chang', username: '@kevinc', avatar: 'https://i.pravatar.cc/150?img=90' },
      { id: '21', name: 'Rachel Green', username: '@rachelg', avatar: 'https://i.pravatar.cc/150?img=95' },
      { id: '22', name: 'James Miller', username: '@jamesm', avatar: 'https://i.pravatar.cc/150?img=10' },
      { id: '23', name: 'Anna Taylor', username: '@annat', avatar: 'https://i.pravatar.cc/150?img=14' },
    ],
    participantCount: 6,
    groupAvatar: undefined,
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

