import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

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
export const useConversationSwipePreferencesStore =
  create<ConversationSwipePreferencesState>()(
    subscribeWithSelector((set) => ({
      leftSwipeAction: DEFAULT_LEFT_ACTION,
      rightSwipeAction: DEFAULT_RIGHT_ACTION,

      setLeftSwipeAction: (action) => {
        set({ leftSwipeAction: action });
      },

      setRightSwipeAction: (action) => {
        set({ rightSwipeAction: action });
      },
    }))
  );


