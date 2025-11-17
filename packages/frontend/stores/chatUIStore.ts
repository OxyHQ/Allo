import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/**
 * Chat UI Store
 * 
 * Manages UI state for chat features including:
 * - Visible message timestamps (which message is showing timestamp)
 * - Input text by conversation
 * - Attachment menu state
 * - Keyboard visibility
 * - Other UI-related state
 * 
 * Uses Zustand with subscribeWithSelector middleware for optimized subscriptions.
 * Always use selectors when subscribing to prevent unnecessary re-renders.
 * 
 * @example
 * ```tsx
 * // Good: Using selector
 * const visibleTimestampId = useChatUIStore(state => state.getVisibleTimestampId('conv-1'));
 * 
 * // Bad: Subscribing to entire store
 * const store = useChatUIStore();
 * ```
 */

interface ChatUIState {
  // Visible timestamp by conversation (only one message can show timestamp at a time)
  visibleTimestampByConversation: Record<string, string | null>;
  
  // Input text by conversation
  inputTextByConversation: Record<string, string>;
  
  // Attachment menu open state by conversation
  isAttachmentMenuOpenByConversation: Record<string, boolean>;
  
  // Actions
  setVisibleTimestamp: (conversationId: string, messageId: string | null) => void;
  setInputText: (conversationId: string, text: string) => void;
  clearInputText: (conversationId: string) => void;
  setAttachmentMenuOpen: (conversationId: string, isOpen: boolean) => void;
  clearConversationUI: (conversationId: string) => void;
  
  // Selectors
  getVisibleTimestampId: (conversationId: string) => string | null;
  getInputText: (conversationId: string) => string;
  isAttachmentMenuOpen: (conversationId: string) => boolean;
}

export const useChatUIStore = create<ChatUIState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    visibleTimestampByConversation: {},
    inputTextByConversation: {},
    isAttachmentMenuOpenByConversation: {},

    // Actions
    setVisibleTimestamp: (conversationId, messageId) => {
      set((state) => ({
        visibleTimestampByConversation: {
          ...state.visibleTimestampByConversation,
          [conversationId]: messageId,
        },
      }));
    },

    setInputText: (conversationId, text) => {
      set((state) => ({
        inputTextByConversation: {
          ...state.inputTextByConversation,
          [conversationId]: text,
        },
      }));
    },

    clearInputText: (conversationId) => {
      set((state) => {
        const { [conversationId]: removed, ...inputTextByConversation } = state.inputTextByConversation;
        return { inputTextByConversation };
      });
    },

    setAttachmentMenuOpen: (conversationId, isOpen) => {
      set((state) => ({
        isAttachmentMenuOpenByConversation: {
          ...state.isAttachmentMenuOpenByConversation,
          [conversationId]: isOpen,
        },
      }));
    },

    clearConversationUI: (conversationId) => {
      set((state) => {
        const { [conversationId]: removedTimestamp, ...visibleTimestampByConversation } = 
          state.visibleTimestampByConversation;
        const { [conversationId]: removedInput, ...inputTextByConversation } = 
          state.inputTextByConversation;
        const { [conversationId]: removedMenu, ...isAttachmentMenuOpenByConversation } = 
          state.isAttachmentMenuOpenByConversation;
        
        return {
          visibleTimestampByConversation,
          inputTextByConversation,
          isAttachmentMenuOpenByConversation,
        };
      });
    },

    // Selectors
    getVisibleTimestampId: (conversationId) => {
      return get().visibleTimestampByConversation[conversationId] || null;
    },

    getInputText: (conversationId) => {
      return get().inputTextByConversation[conversationId] || '';
    },

    isAttachmentMenuOpen: (conversationId) => {
      return get().isAttachmentMenuOpenByConversation[conversationId] || false;
    },
  }))
);


