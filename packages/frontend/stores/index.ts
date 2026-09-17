/**
 * Centralized Store Exports
 *
 * Provides a single entry point for the Zustand stores that survive the
 * platform cut-over: UI state, preferences and the people cache. Conversations
 * and messages are no longer stores — `@allo/react` owns them, and the chat
 * view-model types live in `@/lib/chat/model`, re-exported here so components
 * keep one import path.
 */

export type {
  Conversation,
  ConversationParticipant,
  ConversationType,
  Message,
  MediaItem,
  MessageAttachment,
  MessageAttachmentKind,
  MessageReadStatus,
  StickerItem,
} from '@/lib/chat/model';

export { useChatUIStore } from './chatUIStore';
export { useMessagePreferencesStore } from './messagePreferencesStore';
export {
  useConversationSwipePreferencesStore,
} from './conversationSwipePreferencesStore';
export type { SwipeActionType } from './conversationSwipePreferencesStore';
export { useConversationThemeStore } from './conversationThemeStore';

// Existing stores
export { useUsersStore } from './usersStore';
export type { UserEntity } from './usersStore';

// Appearance store
export { useAppearanceStore } from './appearanceStore';
