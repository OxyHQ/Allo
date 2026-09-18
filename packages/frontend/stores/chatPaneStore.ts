import { create } from 'zustand';

/**
 * Whether the conversation's info pane is open beside it. Only the wide layout
 * reads this: on a phone the info is its own route (`/c/:id/info`), and Back
 * closes it.
 */
interface ChatPaneState {
  infoOpen: boolean;
  toggleInfo: () => void;
  closeInfo: () => void;
}

export const useChatPaneStore = create<ChatPaneState>((set) => ({
  infoOpen: false,
  toggleInfo: () => set((state) => ({ infoOpen: !state.infoOpen })),
  closeInfo: () => set({ infoOpen: false }),
}));
