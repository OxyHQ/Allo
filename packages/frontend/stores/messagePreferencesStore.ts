import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';

interface MessagePreferencesState {
  messageTextSize: number;

  setMessageTextSize: (size: number) => void;
  resetMessageTextSize: () => void;
}

/**
 * Message Preferences Store
 *
 * Holds user-adjustable chat preferences such as message text size.
 * Exposed via selectors for future settings UI integration.
 */
export const useMessagePreferencesStore = create<MessagePreferencesState>()(
  subscribeWithSelector((set) => ({
    messageTextSize: MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE,

    setMessageTextSize: (size: number) => {
      set({ messageTextSize: size });
    },

    resetMessageTextSize: () => {
      set({ messageTextSize: MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE });
    },
  }))
);

