import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/**
 * Messages Store
 * 
 * Manages message state including:
 * - Messages organized by conversation ID
 * - Message sending and receiving
 * - Message updates and deletions
 * - Loading and error states
 * 
 * Uses Zustand with subscribeWithSelector middleware for optimized subscriptions.
 * Always use selectors when subscribing to prevent unnecessary re-renders.
 * 
 * @example
 * ```tsx
 * // Good: Using selector
 * const messages = useMessagesStore(state => state.getMessages('conv-1'));
 * 
 * // Bad: Subscribing to entire store
 * const store = useMessagesStore();
 * ```
 */

export interface MediaItem {
  id: string;
  type: 'image' | 'video' | 'gif';
}

export interface Message {
  id: string;
  text: string;
  senderId: string;
  senderName?: string;
  timestamp: Date;
  isSent: boolean;
  conversationId: string;
  messageType?: 'user' | 'ai'; // Type of message: user (with bubble) or ai (plain text, no bubble)
  media?: MediaItem[]; // Array of media attachments (images, videos, gifs)
  // Future: Add support for reactions, etc.
  // reactions?: Reaction[];
}

interface MessagesState {
  // Data: messages organized by conversation ID
  messagesByConversation: Record<string, Message[]>;
  
  // Loading states by conversation
  loadingByConversation: Record<string, boolean>;
  errorByConversation: Record<string, string | null>;
  
  // Last updated timestamps by conversation
  lastUpdatedByConversation: Record<string, number>;
  
  // Actions
  setMessages: (conversationId: string, messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  clearMessages: (conversationId: string) => void;
  
  // Async actions
  fetchMessages: (conversationId: string) => Promise<void>;
  sendMessage: (conversationId: string, text: string, senderId: string) => Promise<Message | null>;
  
  // Selectors
  getMessages: (conversationId: string) => Message[];
  getLatestMessage: (conversationId: string) => Message | undefined;
  isLoading: (conversationId: string) => boolean;
  getError: (conversationId: string) => string | null;
}

// Mock messages data - will be replaced with API calls
import { getMockMessages } from '@/utils/mockMessages';

export const useMessagesStore = create<MessagesState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    messagesByConversation: {},
    loadingByConversation: {},
    errorByConversation: {},
    lastUpdatedByConversation: {},

    // Actions
    setMessages: (conversationId, messages) => {
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: messages,
        },
        lastUpdatedByConversation: {
          ...state.lastUpdatedByConversation,
          [conversationId]: Date.now(),
        },
        errorByConversation: {
          ...state.errorByConversation,
          [conversationId]: null,
        },
      }));
    },

    addMessage: (message) => {
      set((state) => {
        const existing = state.messagesByConversation[message.conversationId] || [];
        const updated = [...existing, message];
        return {
          messagesByConversation: {
            ...state.messagesByConversation,
            [message.conversationId]: updated,
          },
          lastUpdatedByConversation: {
            ...state.lastUpdatedByConversation,
            [message.conversationId]: Date.now(),
          },
        };
      });
    },

    updateMessage: (conversationId, messageId, updates) => {
      set((state) => {
        const messages = state.messagesByConversation[conversationId] || [];
        const updated = messages.map(msg =>
          msg.id === messageId ? { ...msg, ...updates } : msg
        );
        return {
          messagesByConversation: {
            ...state.messagesByConversation,
            [conversationId]: updated,
          },
          lastUpdatedByConversation: {
            ...state.lastUpdatedByConversation,
            [conversationId]: Date.now(),
          },
        };
      });
    },

    removeMessage: (conversationId, messageId) => {
      set((state) => {
        const messages = state.messagesByConversation[conversationId] || [];
        const filtered = messages.filter(msg => msg.id !== messageId);
        return {
          messagesByConversation: {
            ...state.messagesByConversation,
            [conversationId]: filtered,
          },
          lastUpdatedByConversation: {
            ...state.lastUpdatedByConversation,
            [conversationId]: Date.now(),
          },
        };
      });
    },

    clearMessages: (conversationId) => {
      set((state) => {
        const { [conversationId]: removed, ...messagesByConversation } = state.messagesByConversation;
        const { [conversationId]: removedLoading, ...loadingByConversation } = state.loadingByConversation;
        const { [conversationId]: removedError, ...errorByConversation } = state.errorByConversation;
        const { [conversationId]: removedUpdated, ...lastUpdatedByConversation } = state.lastUpdatedByConversation;
        
        return {
          messagesByConversation,
          loadingByConversation,
          errorByConversation,
          lastUpdatedByConversation,
        };
      });
    },

    // Async actions
    fetchMessages: async (conversationId) => {
      // Don't fetch if already loading or if messages already exist
      const currentState = get();
      if (currentState.loadingByConversation[conversationId]) {
        return; // Already loading
      }
      
      const existingMessages = currentState.messagesByConversation[conversationId];
      if (existingMessages && existingMessages.length > 0) {
        return; // Messages already loaded
      }

      set((state) => ({
        loadingByConversation: {
          ...state.loadingByConversation,
          [conversationId]: true,
        },
        errorByConversation: {
          ...state.errorByConversation,
          [conversationId]: null,
        },
      }));

      try {
        // TODO: Replace with actual API call
        // const response = await messageService.getMessages(conversationId);
        // const messages = response.data.map(msg => ({
        //   ...msg,
        //   timestamp: new Date(msg.timestamp),
        // }));
        
        // For now, use mock data
        const mockMessages = getMockMessages(conversationId);
        const messages = mockMessages.map(msg => ({
          ...msg,
          conversationId,
        }));
        
        get().setMessages(conversationId, messages);
        set((state) => ({
          loadingByConversation: {
            ...state.loadingByConversation,
            [conversationId]: false,
          },
        }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch messages';
        set((state) => ({
          loadingByConversation: {
            ...state.loadingByConversation,
            [conversationId]: false,
          },
          errorByConversation: {
            ...state.errorByConversation,
            [conversationId]: errorMessage,
          },
        }));
      }
    },

    sendMessage: async (conversationId, text, senderId) => {
      try {
        // TODO: Replace with actual API call
        // const response = await messageService.sendMessage({
        //   conversationId,
        //   text,
        //   senderId,
        // });
        // const message = response.data;
        
        // For now, create message locally
        const message: Message = {
          id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          text: text.trim(),
          senderId,
          timestamp: new Date(),
          isSent: true,
          conversationId,
        };

        get().addMessage(message);
        
        // TODO: Optimistically update conversation last message
        // const conversationsStore = useConversationsStore.getState();
        // conversationsStore.updateConversation(conversationId, {
        //   lastMessage: text,
        //   timestamp: formatTimeAgo(new Date()),
        // });

        return message;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
        set((state) => ({
          errorByConversation: {
            ...state.errorByConversation,
            [conversationId]: errorMessage,
          },
        }));
        return null;
      }
    },

    // Selectors
    getMessages: (conversationId) => {
      return get().messagesByConversation[conversationId] || [];
    },

    getLatestMessage: (conversationId) => {
      const messages = get().getMessages(conversationId);
      return messages.length > 0 ? messages[messages.length - 1] : undefined;
    },

    isLoading: (conversationId) => {
      return get().loadingByConversation[conversationId] || false;
    },

    getError: (conversationId) => {
      return get().errorByConversation[conversationId] || null;
    },
  }))
);

