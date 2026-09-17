import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * The colour theme chosen for each conversation, on THIS device.
 *
 * The legacy backend stored a conversation's theme on the conversation and
 * shared it with every participant; the platform has no such field, and a
 * theme is a preference rather than a message, so it is not sent as one. It is
 * kept here, keyed by conversation id, and is this device's alone: pick "Ocean"
 * on your phone and your laptop still shows "Classic". A preference, not
 * message data, which is why AsyncStorage is the right place for it.
 */
interface ConversationThemeState {
  themeByConversation: Record<string, string>;
  setConversationTheme: (conversationId: string, themeId: string | undefined) => void;
}

export const useConversationThemeStore = create<ConversationThemeState>()(
  persist(
    (set) => ({
      themeByConversation: {},
      setConversationTheme: (conversationId, themeId) => {
        set((state) => {
          const next = { ...state.themeByConversation };
          if (themeId === undefined) delete next[conversationId];
          else next[conversationId] = themeId;
          return { themeByConversation: next };
        });
      },
    }),
    {
      name: 'conversation-themes',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    },
  ),
);

/** The theme id chosen for a conversation on this device, if any. */
export function useConversationThemeId(conversationId: string | undefined): string | undefined {
  return useConversationThemeStore((state) => (conversationId ? state.themeByConversation[conversationId] : undefined));
}
