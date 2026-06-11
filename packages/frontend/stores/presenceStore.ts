import { create } from 'zustand';

/** One user's online/last-seen presence. */
export interface PresenceEntry {
  online: boolean;
  /** ISO-8601 timestamp of last connection, or null if unknown. */
  lastSeenAt: string | null;
}

interface PresenceState {
  /** Presence keyed by user id. */
  byUserId: Record<string, PresenceEntry>;
  /** Apply a single `presence:update` event. */
  setPresence: (userId: string, online: boolean, lastSeenAt: string | null) => void;
  /** Merge a batch of bootstrap entries. */
  setMany: (entries: Record<string, PresenceEntry>) => void;
  /** Read one user's presence (undefined when never seen). */
  getPresence: (userId: string) => PresenceEntry | undefined;
  /** Drop all presence (logout / account switch). */
  clearAll: () => void;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  byUserId: {},

  setPresence: (userId, online, lastSeenAt) => {
    set((state) => ({
      byUserId: {
        ...state.byUserId,
        [userId]: { online, lastSeenAt },
      },
    }));
  },

  setMany: (entries) => {
    if (!entries || Object.keys(entries).length === 0) return;
    set((state) => ({
      byUserId: {
        ...state.byUserId,
        ...entries,
      },
    }));
  },

  getPresence: (userId) => get().byUserId[userId],

  clearAll: () => set({ byUserId: {} }),
}));

/**
 * Per-user presence selector. Subscribing to a single entry (rather than the
 * whole map) keeps FlashList rows isolated: a row only re-renders when ITS
 * user's presence changes, not when any other user's does.
 */
export const usePresence = (userId?: string): PresenceEntry | undefined =>
  usePresenceStore((s) => (userId ? s.byUserId[userId] : undefined));
