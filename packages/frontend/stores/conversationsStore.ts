import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { Conversation, ConversationParticipant, ConversationType } from '@/app/(chat)/index';

/**
 * Conversations Store
 * 
 * Manages conversation state including:
 * - List of all conversations
 * - Current active conversation
 * - Conversation metadata and participants
 * - Loading and error states
 * 
 * Uses Zustand with subscribeWithSelector middleware for optimized subscriptions.
 * Always use selectors when subscribing to prevent unnecessary re-renders.
 * 
 * @example
 * ```tsx
 * // Good: Using selector
 * const conversations = useConversationsStore(state => state.conversations);
 * 
 * // Bad: Subscribing to entire store
 * const store = useConversationsStore();
 * ```
 */

interface ConversationsState {
  // Data
  conversations: Conversation[];
  conversationsById: Record<string, Conversation>;
  activeConversationId: string | null;
  
  // Loading states
  isLoading: boolean;
  isRefreshing: boolean;
  error: string | null;
  
  // Last updated timestamp
  lastUpdated: number;
  
  // Actions
  setConversations: (conversations: Conversation[]) => void;
  addConversation: (conversation: Conversation) => void;
  updateConversation: (id: string, updates: Partial<Conversation>) => void;
  removeConversation: (id: string) => void;
  setActiveConversation: (id: string | null) => void;
  
  // Async actions
  fetchConversations: () => Promise<void>;
  refreshConversations: () => Promise<void>;
  markAsRead: (id: string) => void;
  
  // Selectors (computed values)
  getConversation: (id: string) => Conversation | undefined;
  getUnreadCount: () => number;
  hasUnreadMessages: (id: string) => boolean;
}

const createDefaultConversations = (): Conversation[] => [
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
    name: 'Team Alpha',
    lastMessage: 'Alex: Great work everyone! 🎉',
    timestamp: '5m ago',
    unreadCount: 3,
    groupName: 'Team Alpha',
    participantCount: 5,
    participants: [
      {
        id: 'current-user',
        name: { first: 'You', last: '' },
        username: 'you',
      },
      {
        id: '1',
        name: { first: 'Sarah', last: 'Chen' },
        username: 'sarah',
        avatar: 'https://i.pravatar.cc/150?img=1',
      },
      {
        id: '2',
        name: { first: 'Michael', last: 'Rodriguez' },
        username: 'michael',
        avatar: 'https://i.pravatar.cc/150?img=5',
      },
      {
        id: '3',
        name: { first: 'Emily', last: 'Watson' },
        username: 'emily',
        avatar: 'https://i.pravatar.cc/150?img=9',
      },
      {
        id: '4',
        name: { first: 'David', last: 'Kim' },
        username: 'david',
        avatar: 'https://i.pravatar.cc/150?img=12',
      },
    ],
  },
  {
    id: '6',
    type: 'group',
    name: 'Weekend Plans',
    lastMessage: 'Jordan: Count me in!',
    timestamp: '1h ago',
    unreadCount: 0,
    groupName: 'Weekend Plans',
    participantCount: 4,
    participants: [
      {
        id: 'current-user',
        name: { first: 'You', last: '' },
        username: 'you',
      },
      {
        id: '7',
        name: { first: 'Jordan', last: 'Taylor' },
        username: 'jordan',
        avatar: 'https://i.pravatar.cc/150?img=15',
      },
      {
        id: '8',
        name: { first: 'Morgan', last: 'Lee' },
        username: 'morgan',
        avatar: 'https://i.pravatar.cc/150?img=20',
      },
      {
        id: '9',
        name: { first: 'Casey', last: 'Brown' },
        username: 'casey',
        avatar: 'https://i.pravatar.cc/150?img=25',
      },
    ],
  },
  {
    id: '7',
    type: 'direct',
    name: 'Alex Johnson',
    lastMessage: 'Can we reschedule?',
    timestamp: '2h ago',
    unreadCount: 0,
    avatar: 'https://i.pravatar.cc/150?img=3',
  },
  {
    id: '8',
    type: 'group',
    name: 'Book Club',
    lastMessage: 'Riley: This month\'s book is amazing!',
    timestamp: '3h ago',
    unreadCount: 5,
    groupName: 'Book Club',
    participantCount: 8,
    participants: [
      {
        id: 'current-user',
        name: { first: 'You', last: '' },
        username: 'you',
      },
      {
        id: '10',
        name: { first: 'Riley', last: 'Martinez' },
        username: 'riley',
        avatar: 'https://i.pravatar.cc/150?img=30',
      },
      {
        id: '11',
        name: { first: 'Taylor', last: 'Anderson' },
        username: 'taylor',
        avatar: 'https://i.pravatar.cc/150?img=35',
      },
      {
        id: '12',
        name: { first: 'Jamie', last: 'Wilson' },
        username: 'jamie',
        avatar: 'https://i.pravatar.cc/150?img=40',
      },
    ],
  },
  {
    id: '9',
    type: 'direct',
    name: 'Jordan Taylor',
    lastMessage: 'Thanks for the recommendation!',
    timestamp: '4h ago',
    unreadCount: 0,
    avatar: 'https://i.pravatar.cc/150?img=15',
  },
  {
    id: '10',
    type: 'direct',
    name: 'Morgan Lee',
    lastMessage: 'See you tomorrow!',
    timestamp: '5h ago',
    unreadCount: 0,
    avatar: 'https://i.pravatar.cc/150?img=20',
  },
];

export const useConversationsStore = create<ConversationsState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    conversations: createDefaultConversations(),
    conversationsById: {},
    activeConversationId: null,
    isLoading: false,
    isRefreshing: false,
    error: null,
    lastUpdated: Date.now(),

    // Initialize conversationsById from conversations array
    ...(() => {
      const conversations = createDefaultConversations();
      const conversationsById: Record<string, Conversation> = {};
      conversations.forEach(conv => {
        conversationsById[conv.id] = conv;
      });
      return { conversations, conversationsById };
    })(),

    // Actions
    setConversations: (conversations) => {
      const conversationsById: Record<string, Conversation> = {};
      conversations.forEach(conv => {
        conversationsById[conv.id] = conv;
      });
      set({
        conversations,
        conversationsById,
        lastUpdated: Date.now(),
        error: null,
      });
    },

    addConversation: (conversation) => {
      set((state) => {
        const exists = state.conversationsById[conversation.id];
        if (exists) {
          return state; // Don't add duplicates
        }
        return {
          conversations: [conversation, ...state.conversations],
          conversationsById: {
            ...state.conversationsById,
            [conversation.id]: conversation,
          },
          lastUpdated: Date.now(),
        };
      });
    },

    updateConversation: (id, updates) => {
      set((state) => {
        const existing = state.conversationsById[id];
        if (!existing) return state;

        const updated = { ...existing, ...updates };
        return {
          conversations: state.conversations.map(conv =>
            conv.id === id ? updated : conv
          ),
          conversationsById: {
            ...state.conversationsById,
            [id]: updated,
          },
          lastUpdated: Date.now(),
        };
      });
    },

    removeConversation: (id) => {
      set((state) => {
        const { [id]: removed, ...conversationsById } = state.conversationsById;
        return {
          conversations: state.conversations.filter(conv => conv.id !== id),
          conversationsById,
          activeConversationId: state.activeConversationId === id ? null : state.activeConversationId,
          lastUpdated: Date.now(),
        };
      });
    },

    setActiveConversation: (id) => {
      set({ activeConversationId: id });
    },

    // Async actions
    fetchConversations: async () => {
      set({ isLoading: true, error: null });
      try {
        // TODO: Replace with actual API call
        // const response = await conversationService.getConversations();
        // const conversations = response.data;
        
        // For now, use mock data
        const conversations = createDefaultConversations();
        get().setConversations(conversations);
        set({ isLoading: false });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch conversations';
        set({ isLoading: false, error: errorMessage });
      }
    },

    refreshConversations: async () => {
      set({ isRefreshing: true, error: null });
      try {
        // TODO: Replace with actual API call
        await get().fetchConversations();
        set({ isRefreshing: false });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to refresh conversations';
        set({ isRefreshing: false, error: errorMessage });
      }
    },

    markAsRead: (id) => {
      get().updateConversation(id, { unreadCount: 0 });
    },

    // Selectors
    getConversation: (id) => {
      return get().conversationsById[id];
    },

    getUnreadCount: () => {
      return get().conversations.reduce((total, conv) => total + conv.unreadCount, 0);
    },

    hasUnreadMessages: (id) => {
      const conversation = get().conversationsById[id];
      return conversation ? conversation.unreadCount > 0 : false;
    },
  }))
);

