import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { Conversation, ConversationParticipant, ConversationType } from '@/app/(chat)/index';
import { api } from '@/utils/api';

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
  archiveConversation: (id: string) => void;
  unarchiveConversation: (id: string) => void;
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

const withArchiveFlag = (conversation: Conversation): Conversation => ({
  ...conversation,
  isArchived: conversation.isArchived ?? false,
});

export const useConversationsStore = create<ConversationsState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state - start with empty conversations (will be fetched from API)
    conversations: [],
    conversationsById: {},
    activeConversationId: null,
    isLoading: false,
    isRefreshing: false,
    error: null,
    lastUpdated: Date.now(),

    // Actions
    setConversations: (conversations) => {
      const normalized = conversations.map(withArchiveFlag);
      const conversationsById: Record<string, Conversation> = {};
      normalized.forEach(conv => {
        conversationsById[conv.id] = conv;
      });
      set({
        conversations: normalized,
        conversationsById,
        lastUpdated: Date.now(),
        error: null,
      });
    },

    addConversation: (conversation) => {
      const normalized = withArchiveFlag(conversation);
      set((state) => {
        const exists = state.conversationsById[normalized.id];
        if (exists) {
          return state; // Don't add duplicates
        }
        return {
          conversations: [normalized, ...state.conversations],
          conversationsById: {
            ...state.conversationsById,
            [normalized.id]: normalized,
          },
          lastUpdated: Date.now(),
        };
      });
    },

    updateConversation: (id, updates) => {
      set((state) => {
        const existing = state.conversationsById[id];
        if (!existing) return state;

        const updated = withArchiveFlag({ ...existing, ...updates });
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

    archiveConversation: (id) => {
      const conversation = get().conversationsById[id];
      if (!conversation) return;
      get().updateConversation(id, { isArchived: true });
    },

    unarchiveConversation: (id) => {
      const conversation = get().conversationsById[id];
      if (!conversation) return;
      get().updateConversation(id, { isArchived: false });
    },

    setActiveConversation: (id) => {
      set({ activeConversationId: id });
    },

    // Async actions
    fetchConversations: async () => {
      set({ isLoading: true, error: null });
      try {
        // Fetch conversations from API
        const response = await api.get<{ conversations: any[] }>('/conversations');
        const apiConversations = response.data.conversations || [];
        
        // Transform API response to frontend Conversation format
        const conversations: Conversation[] = apiConversations.map((conv: any) => {
          // Map participants from API format to frontend format
          const participants: ConversationParticipant[] = (conv.participants || []).map((p: any) => ({
            id: p.userId,
            name: {
              first: p.name?.first || 'Unknown',
              last: p.name?.last || '',
            },
            username: p.username,
            avatar: p.avatar,
          }));

          return {
            id: conv._id || conv.id,
            type: conv.type || 'direct',
            name: conv.name || (conv.type === 'group' ? 'Group Chat' : 'Direct Chat'),
            lastMessage: conv.lastMessage?.text || '',
            timestamp: conv.lastMessageAt ? new Date(conv.lastMessageAt).toISOString() : new Date().toISOString(),
            unreadCount: conv.unreadCounts ? Object.values(conv.unreadCounts).reduce((sum: number, count: any) => sum + (count || 0), 0) : 0,
            avatar: conv.avatar,
            participants,
            groupName: conv.name,
            groupAvatar: conv.avatar,
            participantCount: participants.length,
          };
        });

        get().setConversations(conversations);
        set({ isLoading: false });
      } catch (error) {
        console.error('[Conversations] Error fetching conversations:', error);
        // No fallback - show empty state if API fails
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch conversations';
        set({ 
          isLoading: false, 
          error: errorMessage,
          conversations: [], // Clear conversations on error
          conversationsById: {},
        });
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

