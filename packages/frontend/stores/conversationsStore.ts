import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { Conversation, ConversationParticipant, ConversationType } from '@/app/(chat)/index';
import { api } from '@/utils/api';
import { useUsersStore } from './usersStore';

/**
 * Format last message with sender name for group conversations
 * Example: "Albert: Hello" for groups, just "Hello" for direct chats
 * 
 * Professional WhatsApp-style formatting - efficient and clean
 */
function formatLastMessageForGroup(
  messageText: string,
  senderId: string | undefined,
  conversation: { type: ConversationType; participants?: ConversationParticipant[] },
  currentUserId?: string
): string {
  // Don't format empty messages or non-group conversations
  if (!messageText || conversation.type !== 'group' || !senderId) {
    return messageText;
  }

  // Get sender name from participants or usersStore (O(1) lookup from cache)
  const participant = conversation.participants?.find(p => p.id === senderId);
  const usersStore = useUsersStore.getState();
  const senderUser = usersStore.getCachedById(senderId);
  
  let senderName: string | undefined;
  
  // Priority 1: Oxy user data from cache (most reliable)
  if (senderUser) {
    if (typeof senderUser.name === 'string') {
      senderName = senderUser.name.split(' ')[0];
    } else if (senderUser.name?.first) {
      senderName = senderUser.name.first;
    } else if (senderUser.username || senderUser.handle) {
      senderName = senderUser.username || senderUser.handle;
    }
  }
  // Priority 2: Participant data (from backend enrichment)
  else if (participant?.name?.first) {
    senderName = participant.name.first;
  } else if (participant?.username) {
    senderName = participant.username;
  }
  // Priority 3: Current user
  else if (senderId === currentUserId) {
    senderName = 'You';
  }
  
  // Format as "SenderName: Message" for groups (WhatsApp-style)
  if (senderName) {
    return `${senderName}: ${messageText}`;
  }
  
  // Fallback to just message text if no sender name found
  return messageText;
}

/**
 * Efficiently get last message from store (synchronous, O(1) lookup)
 * Professional WhatsApp-style: prefer decrypted cache over API placeholder
 */
function getLastMessageFromStore(conversationId: string): { text: string; senderId: string | undefined } | null {
  try {
    const { useMessagesStore } = require('./messagesStore');
    const messagesStore = useMessagesStore.getState();
    const messages = messagesStore.messagesByConversation[conversationId] || [];
    
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      // Only return if decrypted (not encrypted placeholder)
      if (lastMessage.text && !lastMessage.isEncrypted && lastMessage.text !== '[Encrypted]') {
        return {
          text: lastMessage.text,
          senderId: lastMessage.senderId,
        };
      }
    }
  } catch (error) {
    // Silently fail
  }
  return null;
}

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
      
      // Sort conversations by timestamp (most recent first) - like WhatsApp
      const sorted = [...normalized].sort((a, b) => {
        const timeA = new Date(a.timestamp).getTime();
        const timeB = new Date(b.timestamp).getTime();
        return timeB - timeA; // Most recent first
      });
      
      set({
        conversations: sorted,
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
        
        // Add to conversations and re-sort by timestamp (most recent first)
        const updatedConversations = [normalized, ...state.conversations];
        const sorted = [...updatedConversations].sort((a, b) => {
          const timeA = new Date(a.timestamp).getTime();
          const timeB = new Date(b.timestamp).getTime();
          return timeB - timeA; // Most recent first
        });
        
        return {
          conversations: sorted,
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

        // Note: lastMessage formatting with sender name for groups is done
        // in useRealtimeMessaging hook before calling updateConversation

        const updated = withArchiveFlag({ ...existing, ...updates });
        
        // Update conversation in array and re-sort by timestamp (most recent first)
        const updatedConversations = state.conversations.map(conv =>
          conv.id === id ? updated : conv
        );
        
        // Sort conversations by timestamp (most recent first) - like WhatsApp
        const sorted = [...updatedConversations].sort((a, b) => {
          const timeA = new Date(a.timestamp).getTime();
          const timeB = new Date(b.timestamp).getTime();
          return timeB - timeA; // Most recent first
        });
        
        return {
          conversations: sorted,
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
        // Fetch conversations from API (backend already enriches with Oxy data)
        const response = await api.get<{ conversations: any[] }>('/conversations');
        const apiConversations = response.data.conversations || [];
        
        // Import usersStore dynamically to avoid circular dependency
        const { useUsersStore } = await import('./usersStore');
        const usersStore = useUsersStore.getState();
        
        // Collect all unique user IDs for batch caching (WhatsApp-style efficiency)
        const userIds = new Set<string>();
        apiConversations.forEach((conv: any) => {
          (conv.participants || []).forEach((p: any) => {
            if (p.userId) userIds.add(p.userId);
          });
        });

        // Batch pre-cache user data in zustand (like WhatsApp - efficient prefetching)
        // Backend already enriched with Oxy data, so we just cache it
        const usersToCache: any[] = [];
        apiConversations.forEach((conv: any) => {
          (conv.participants || []).forEach((p: any) => {
            if (p.userId && p.name) {
              // Convert backend format to frontend format
              const user: any = {
                id: p.userId,
                username: p.username,
                avatar: p.avatar,
              };
              
              // Handle name format
              if (typeof p.name === 'string') {
                user.name = p.name;
              } else if (p.name.first || p.name.last) {
                user.name = {
                  first: p.name.first || '',
                  last: p.name.last || '',
                  full: `${p.name.first || ''} ${p.name.last || ''}`.trim() || undefined,
                };
              }
              
              usersToCache.push(user);
            }
          });
        });

        // Batch upsert all users into zustand cache (efficient like WhatsApp)
        if (usersToCache.length > 0) {
          usersStore.upsertMany(usersToCache);
        }

        // Batch check local storage for decrypted messages (efficient - parallel reads)
        const { getMessagesLocally } = await import('@/lib/offlineStorage');
        const encryptedConversationIds = apiConversations
          .filter((conv: any) => conv.lastMessage?.text === '[Encrypted]')
          .map((conv: any) => conv._id || conv.id);
        
        // Parallel fetch last messages from local storage for encrypted conversations
        const localMessagePromises = encryptedConversationIds.map(async (id: string) => {
          try {
            const messages = await getMessagesLocally(id);
            if (messages.length > 0) {
              const lastMsg = messages[messages.length - 1];
              if (lastMsg.text && !lastMsg.isEncrypted && lastMsg.text !== '[Encrypted]') {
                return { conversationId: id, message: lastMsg };
              }
            }
          } catch (error) {
            // Silently fail
          }
          return null;
        });
        
        const localMessages = (await Promise.all(localMessagePromises)).filter(Boolean) as Array<{
          conversationId: string;
          message: { text: string; senderId: string; timestamp: Date };
        }>;
        
        // Create lookup map for O(1) access
        const localMessageMap = new Map(
          localMessages.map(item => [item.conversationId, item.message])
        );

        // Transform API response to frontend Conversation format
        const conversations: Conversation[] = apiConversations.map((conv: any) => {
          // Map participants from API format to frontend format
          const participants: ConversationParticipant[] = (conv.participants || []).map((p: any) => ({
            id: p.userId,
            name: {
              first: p.name?.first || p.name || 'Unknown',
              last: p.name?.last || '',
            },
            username: p.username,
            avatar: p.avatar,
          }));

          const conversationId = conv._id || conv.id;
          
          // Get last message: prefer store (O(1)), then local storage, then API
          let lastMessageText = conv.lastMessage?.text || '';
          let lastMessageSenderId = conv.lastMessage?.senderId;
          
          // Check store first (fastest - synchronous)
          const storeMessage = getLastMessageFromStore(conversationId);
          if (storeMessage) {
            lastMessageText = storeMessage.text;
            lastMessageSenderId = storeMessage.senderId;
          }
          // Check local storage (from batch fetch above)
          else if (lastMessageText === '[Encrypted]') {
            const localMsg = localMessageMap.get(conversationId);
            if (localMsg) {
              lastMessageText = localMsg.text;
              lastMessageSenderId = localMsg.senderId;
            }
          }
          
          // Format last message with sender name for groups (e.g., "Albert: Hello")
          const formattedLastMessage = formatLastMessageForGroup(
            lastMessageText,
            lastMessageSenderId,
            { type: conv.type || 'direct', participants },
            undefined // currentUserId not available here, but function handles it gracefully
          );

          return {
            id: conversationId,
            type: conv.type || 'direct',
            name: conv.name || (conv.type === 'group' ? 'Group Chat' : 'Direct Chat'),
            lastMessage: formattedLastMessage,
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

