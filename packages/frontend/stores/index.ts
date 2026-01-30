/**
 * Centralized Store Exports
 * 
 * Provides a single entry point for all Zustand stores.
 * This makes it easier to import stores and ensures consistency.
 * 
 * @example
 * ```tsx
 * import { useConversationsStore, useMessagesStore, useChatUIStore } from '@/stores';
 * ```
 */

// Chat-related stores
export { useConversationsStore } from './conversationsStore';
export type { Conversation, ConversationParticipant, ConversationType } from '@/app/(chat)/index';

export { useMessagesStore } from './messagesStore';
export type { Message, MediaItem, StickerItem } from './messagesStore';

export { useChatUIStore } from './chatUIStore';
export { useMessagePreferencesStore } from './messagePreferencesStore';
export {
  useConversationSwipePreferencesStore,
} from './conversationSwipePreferencesStore';
export type { SwipeActionType } from './conversationSwipePreferencesStore';

// Existing stores
export { useUsersStore } from './usersStore';
export type { UserEntity } from './usersStore';

// Store from /store directory (legacy)
export { useAppearanceStore } from '../store/appearanceStore';
export { useProfileStore } from '../store/profileStore';

