import { create } from 'zustand';
import {
  persist,
  createJSONStorage,
} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * What a swipe on a conversation row does.
 *
 * `delete` leaves the conversation — the platform has no archive, so the
 * only thing a swipe can do to a conversation is take you out of it — and
 * `none` disables the direction. A preference saved by an older build as
 * `archive` is migrated to `none` rather than to `delete`: turning a gesture
 * that used to hide a chat into one that leaves it is not a migration anyone
 * asked for.
 */
export type SwipeActionType = 'delete' | 'none';

interface ConversationSwipePreferencesState {
  leftSwipeAction: SwipeActionType;
  rightSwipeAction: SwipeActionType;

  setLeftSwipeAction: (action: SwipeActionType) => void;
  setRightSwipeAction: (action: SwipeActionType) => void;
}

const DEFAULT_LEFT_ACTION: SwipeActionType = 'none';
const DEFAULT_RIGHT_ACTION: SwipeActionType = 'delete';

const STORAGE_KEY = 'conversation-swipe-preferences';

/** The migration from the archive-era preference. Pure, so it can be tested. */
export function migrateSwipeAction(value: unknown, fallback: SwipeActionType): SwipeActionType {
  return value === 'delete' || value === 'none' ? value : fallback;
}

export const useConversationSwipePreferencesStore =
  create<ConversationSwipePreferencesState>()(
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
          version: 2,
          migrate: (persisted) => {
            const state = (persisted ?? {}) as Partial<Record<'leftSwipeAction' | 'rightSwipeAction', unknown>>;
            return {
              leftSwipeAction: migrateSwipeAction(state.leftSwipeAction, DEFAULT_LEFT_ACTION),
              rightSwipeAction: migrateSwipeAction(state.rightSwipeAction, DEFAULT_RIGHT_ACTION),
            } as ConversationSwipePreferencesState;
          },
        }
    )
  );
