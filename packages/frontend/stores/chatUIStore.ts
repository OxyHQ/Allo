import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';

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
  
  // Reply to message ID by conversation
  replyToByConversation: Record<string, string | undefined>;
  
  // Actions
  setVisibleTimestamp: (conversationId: string, messageId: string | null) => void;
  setInputText: (conversationId: string, text: string) => void;
  clearInputText: (conversationId: string) => void;
  setAttachmentMenuOpen: (conversationId: string, isOpen: boolean) => void;
  setReplyTo: (conversationId: string, messageId: string | undefined) => void;
  clearConversationUI: (conversationId: string) => void;
  
  // Selectors
  getVisibleTimestampId: (conversationId: string) => string | null;
  getInputText: (conversationId: string) => string;
  isAttachmentMenuOpen: (conversationId: string) => boolean;
}

export const useChatUIStore = create<ChatUIState>()(
  subscribeWithSelector(
    immer((set, get) => ({
    // Initial state
    visibleTimestampByConversation: {},
    inputTextByConversation: {},
    isAttachmentMenuOpenByConversation: {},
    replyToByConversation: {},

    // Actions - Optimized with immer for O(1) updates (critical for typing performance)
    setVisibleTimestamp: (conversationId, messageId) => {
      set((state) => {
        state.visibleTimestampByConversation[conversationId] = messageId;
      });
    },

    setInputText: (conversationId, text) => {
      set((state) => {
        state.inputTextByConversation[conversationId] = text;
      });
    },

    clearInputText: (conversationId) => {
      set((state) => {
        delete state.inputTextByConversation[conversationId];
      });
    },

    setAttachmentMenuOpen: (conversationId, isOpen) => {
      set((state) => {
        state.isAttachmentMenuOpenByConversation[conversationId] = isOpen;
      });
    },

    setReplyTo: (conversationId, messageId) => {
      set((state) => {
        state.replyToByConversation[conversationId] = messageId;
      });
    },

    clearConversationUI: (conversationId) => {
      set((state) => {
        delete state.visibleTimestampByConversation[conversationId];
        delete state.inputTextByConversation[conversationId];
        delete state.isAttachmentMenuOpenByConversation[conversationId];
        delete state.replyToByConversation[conversationId];
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
  })))
);


