import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Whether THIS device has already been asked "Restore your history?".
 *
 * A fresh device whose account has a backup on the server is offered a restore
 * once, at first run. "Not now" is an answer, and an answer given once should
 * not be asked for again on every launch — but it is this device's answer,
 * keyed by the instance the SDK enrolled it as: start over after a revocation
 * and the new instance is asked afresh, because it IS a fresh device as far as
 * history goes. A preference rather than message data, which is why it lives
 * here beside the conversation themes and not in the encrypted store.
 */
interface RestorePromptState {
  /** Instance ids that have answered the prompt, either way. */
  answeredInstanceIds: Record<string, true>;
  markAnswered: (instanceId: string) => void;
}

export const useRestorePromptStore = create<RestorePromptState>()(
  persist(
    (set) => ({
      answeredInstanceIds: {},
      markAnswered: (instanceId) => {
        set((state) => (state.answeredInstanceIds[instanceId] ? state : { answeredInstanceIds: { ...state.answeredInstanceIds, [instanceId]: true } }));
      },
    }),
    {
      name: 'restore-prompt',
      storage: createJSONStorage(() => AsyncStorage),
      version: 1,
    },
  ),
);
