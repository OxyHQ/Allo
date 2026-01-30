/**
 * Seeds mock conversation and message data into Zustand stores
 * for local testing without a backend.
 *
 * Usage: call `seedMockData()` once at startup (dev-only).
 */

import { useConversationsStore } from '@/stores/conversationsStore';
import { useMessagesStore } from '@/stores/messagesStore';
import { getMockMessages } from './mockMessages';
import type { Conversation } from '@/app/(chat)/index';

const MOCK_CURRENT_USER_ID = 'current-user';

const mockConversations: Conversation[] = [
  {
    id: '1',
    type: 'direct',
    name: 'Sarah Chen',
    lastMessage: 'Check out this new restaurant I found!',
    timestamp: new Date(Date.now() - 20 * 1000).toISOString(),
    unreadCount: 2,
    participants: [
      { id: MOCK_CURRENT_USER_ID, name: { first: 'You', last: '' } },
      { id: '1', name: { first: 'Sarah', last: 'Chen' }, username: 'sarahchen' },
    ],
  },
  {
    id: '2',
    type: 'direct',
    name: 'Michael Rodriguez',
    lastMessage: 'Happy to help! Anytime 👍',
    timestamp: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    unreadCount: 0,
    participants: [
      { id: MOCK_CURRENT_USER_ID, name: { first: 'You', last: '' } },
      { id: '2', name: { first: 'Michael', last: 'Rodriguez' }, username: 'mrodriguez' },
    ],
  },
  {
    id: '3',
    type: 'direct',
    name: 'Emily Watson',
    lastMessage: 'Will do! Already have it ready 📊',
    timestamp: new Date(Date.now() - 55 * 60 * 1000).toISOString(),
    unreadCount: 0,
    participants: [
      { id: MOCK_CURRENT_USER_ID, name: { first: 'You', last: '' } },
      { id: '3', name: { first: 'Emily', last: 'Watson' }, username: 'ewatson' },
    ],
  },
  {
    id: '4',
    type: 'direct',
    name: 'David Kim',
    lastMessage: "Here's the updated version with your suggestions",
    timestamp: new Date(Date.now() - 1.5 * 60 * 60 * 1000).toISOString(),
    unreadCount: 1,
    participants: [
      { id: MOCK_CURRENT_USER_ID, name: { first: 'You', last: '' } },
      { id: '4', name: { first: 'David', last: 'Kim' }, username: 'dkim' },
    ],
  },
  {
    id: '5',
    type: 'group',
    name: 'Design Team',
    groupName: 'Design Team',
    lastMessage: 'Jessica: Here are some alternative color schemes',
    timestamp: new Date(Date.now() - 1 * 60 * 1000).toISOString(),
    unreadCount: 3,
    participantCount: 4,
    participants: [
      { id: MOCK_CURRENT_USER_ID, name: { first: 'You', last: '' } },
      { id: '6', name: { first: 'Jessica', last: 'Lee' }, username: 'jesslee' },
      { id: '7', name: { first: 'Ryan', last: 'Park' }, username: 'rpark' },
      { id: '8', name: { first: 'Alex', last: 'Jones' }, username: 'ajones' },
    ],
  },
  {
    id: '6',
    type: 'group',
    name: 'Weekend Plans',
    groupName: 'Weekend Plans',
    lastMessage: "Tom: This is the trail we'll be hiking!",
    timestamp: new Date(Date.now() - 50 * 60 * 1000).toISOString(),
    unreadCount: 0,
    participantCount: 4,
    participants: [
      { id: MOCK_CURRENT_USER_ID, name: { first: 'You', last: '' } },
      { id: '10', name: { first: 'Lisa', last: 'Adams' }, username: 'ladams' },
      { id: '11', name: { first: 'Tom', last: 'Brown' }, username: 'tbrown' },
      { id: '12', name: { first: 'Nina', last: 'Scott' }, username: 'nscott' },
    ],
  },
  {
    id: '7',
    type: 'group',
    name: 'Family Group',
    groupName: 'Family Group',
    lastMessage: "Can't wait to see everyone.",
    timestamp: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    unreadCount: 0,
    participantCount: 4,
    participants: [
      { id: MOCK_CURRENT_USER_ID, name: { first: 'You', last: '' } },
      { id: '13', name: { first: 'Mom', last: '' } },
      { id: '14', name: { first: 'Dad', last: '' } },
      { id: '15', name: { first: 'Emma', last: '' } },
    ],
  },
  {
    id: '9',
    type: 'direct',
    name: 'Priya Sharma',
    lastMessage: 'Perfect! Looking forward to it 🎉',
    timestamp: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    unreadCount: 0,
    participants: [
      { id: MOCK_CURRENT_USER_ID, name: { first: 'You', last: '' } },
      { id: '9', name: { first: 'Priya', last: 'Sharma' }, username: 'psharma' },
    ],
  },
];

/**
 * Seed mock conversations and messages into Zustand stores.
 * Safe to call multiple times — it no-ops if data already exists.
 */
export function seedMockData(): void {
  const conversationsStore = useConversationsStore.getState();
  const messagesStore = useMessagesStore.getState();

  // Only seed if store is empty (don't overwrite real data)
  if (conversationsStore.conversations.length > 0) {
    return;
  }

  console.log('[Mock] Seeding mock conversations and messages for local testing');

  // Seed conversations
  conversationsStore.setConversations(mockConversations);

  // Seed messages for each conversation
  for (const conv of mockConversations) {
    const mockMsgs = getMockMessages(conv.id);
    if (mockMsgs.length > 0) {
      const storeMessages = mockMsgs.map((m) => ({
        ...m,
        conversationId: conv.id,
        readStatus: m.isSent ? ('read' as const) : undefined,
      }));
      messagesStore.setMessages(conv.id, storeMessages);
    }
  }

  console.log('[Mock] Seeded %d conversations with messages', mockConversations.length);
}
