import { create } from 'zustand';

export interface UserEntity {
  id: string;
  _id?: string;
  username?: string;
  name?: { displayName?: string; full?: string; first?: string; last?: string } | string;
  handle?: string; // alias for username if needed
  avatar?: string | null; // matches the canonical @oxyhq SDK `User.avatar` (nullable)
  verified?: boolean;
  bio?: string;
  description?: string;
  privacySettings?: unknown;
  links?: unknown;
  linksMetadata?: unknown;
  createdAt?: string;
  // Allow any additional fields coming from services
  [key: string]: unknown;
}

interface UsersState {
  /** Each person by account id, as the directory last answered. */
  usersById: Record<string, { data: UserEntity }>;
  /** Merges each user into what is cached for its id. */
  upsertMany: (users: (Partial<UserEntity> & { id?: string })[]) => void;
  getCachedById: (id: string) => UserEntity | undefined;
  clearAll: () => void;
}

/** The people the chat screens draw, cached in memory for this account (`lib/allo/people.ts`). */
export const useUsersStore = create<UsersState>((set, get) => ({
  usersById: {},

  upsertMany: (users) => {
    if (!Array.isArray(users) || users.length === 0) return;
    set((state) => {
      const usersById = { ...state.usersById };
      for (const user of users) {
        const id = String(user?.id ?? user?._id ?? '');
        if (!id) continue;
        usersById[id] = { data: { ...usersById[id]?.data, ...user, id } };
      }
      return { usersById };
    });
  },

  getCachedById: (id) => get().usersById[id]?.data,

  clearAll: () => set({ usersById: {} }),
}));
