import { create } from 'zustand';

/**
 * What somebody typed in a conversation and has not sent, so Back and a return
 * puts it back in the composer.
 *
 * IN MEMORY ONLY, on purpose. A draft is the plaintext of a message that will
 * be end-to-end encrypted, and nothing on the chat path may be written outside
 * `@allo/core`'s encrypted store (`noLegacyChatPath.test.ts`): no AsyncStorage,
 * no React Query persistence. So a draft lasts as long as the app process, and
 * signing out forgets every one of them (`lib/allo/signOut.ts`).
 *
 * Keyed by account AND conversation: two accounts on one device never see each
 * other's drafts through the account switcher.
 */
interface DraftState {
  drafts: Readonly<Record<string, string>>;
  setDraft: (accountId: string, conversationId: string, text: string) => void;
  clearAll: () => void;
}

export function draftKey(accountId: string, conversationId: string): string {
  return `${accountId}\u0000${conversationId}`;
}

export const useDraftStore = create<DraftState>((set) => ({
  drafts: {},
  setDraft: (accountId, conversationId, text) =>
    set((state) => {
      const key = draftKey(accountId, conversationId);
      // Only what would be sent counts: a field of spaces is not a draft.
      if (text.trim() === '') {
        if (!(key in state.drafts)) return state;
        const { [key]: _gone, ...rest } = state.drafts;
        return { drafts: rest };
      }
      if (state.drafts[key] === text) return state;
      return { drafts: { ...state.drafts, [key]: text } };
    }),
  clearAll: () => set({ drafts: {} }),
}));

/** The draft to open a conversation's composer with, read once (not subscribed). */
export function readDraft(accountId: string | undefined, conversationId: string): string {
  if (!accountId) return '';
  return useDraftStore.getState().drafts[draftKey(accountId, conversationId)] ?? '';
}
