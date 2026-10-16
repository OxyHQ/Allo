import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/**
 * Whether the open conversation plays its tones (a message arriving, leaving,
 * failing). This device's preference, on by default; it says nothing about
 * notifications, which the OS owns.
 */
interface SoundState {
  conversationTones: boolean;
  setConversationTones: (on: boolean) => void;
}

export const useSoundStore = create<SoundState>()(
  persist(
    (set) => ({
      conversationTones: true,
      setConversationTones: (on) => set({ conversationTones: on }),
    }),
    {
      name: 'conversation-sounds',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    },
  ),
);
