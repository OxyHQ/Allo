import { create } from 'zustand';
import {
  subscribeWithSelector,
  persist,
  createJSONStorage,
} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type SwipeActionType = 'archive' | 'delete' | 'none';

interface ConversationSwipePreferencesState {
  leftSwipeAction: SwipeActionType;
  rightSwipeAction: SwipeActionType;

  setLeftSwipeAction: (action: SwipeActionType) => void;
  setRightSwipeAction: (action: SwipeActionType) => void;
}

const DEFAULT_LEFT_ACTION: SwipeActionType = 'archive';
const DEFAULT_RIGHT_ACTION: SwipeActionType = 'delete';

/**
 * Stores user preferences for conversation list swipe gestures.
 */
const STORAGE_KEY = 'conversation-swipe-preferences';

export const useConversationSwipePreferencesStore =
  create<ConversationSwipePreferencesState>()(
    subscribeWithSelector(
      persist(
        (set) => ({
          leftSwipeAction: DEFAULT_LEFT_ACTION,
          rightSwipeAction: DEFAULT_RIGHT_ACTION,

          setLeftSwipeAction: (action) => {
            set({ leftSwipeAction: action });
          },

          setRightSwipeAction: (action) => {
            set({ rightSwipeAction: action });
          },
        }),
        {
          name: STORAGE_KEY,
          storage: createJSONStorage(() => AsyncStorage),
          version: 1,
        }
      )
    )
  );

