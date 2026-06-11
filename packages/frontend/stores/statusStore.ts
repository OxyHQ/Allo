import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { api } from '@/utils/api';

/**
 * Status (WhatsApp-style Stories) store.
 *
 * Mirrors the shape returned by `GET /api/status` on the backend. We keep
 * the wire types fully local here (rather than importing from
 * `@allo/shared-types`) to avoid an extra resolver hop in the Metro bundler
 * and to keep the frontend self-contained.
 */

export type StatusType = 'image' | 'video' | 'text';
export type StatusAudienceType = 'all-contacts' | 'except' | 'only';

export interface StatusAudience {
  type: StatusAudienceType;
  userIds: string[];
}

export interface StatusViewer {
  userId: string;
  viewedAt: string;
}

export interface StatusAuthor {
  id?: string;
  userId?: string;
  name?: { first?: string; last?: string } | string;
  username?: string;
  avatar?: string;
}

export interface Status {
  id: string;
  userId: string;
  type: StatusType;
  mediaUrl?: string;
  mediaThumbnailUrl?: string;
  text?: string;
  caption?: string;
  backgroundColor?: string;
  fontFamily?: string;
  audience: StatusAudience;
  viewers: StatusViewer[];
  viewedByMe?: boolean;
  createdAt: string;
  expiresAt: string;
}

export interface StatusGroup {
  userId: string;
  author?: StatusAuthor;
  statuses: Status[];
  lastCreatedAt: string;
  hasUnviewed: boolean;
}

export interface CreateStatusInput {
  type: StatusType;
  mediaUrl?: string;
  mediaThumbnailUrl?: string;
  text?: string;
  caption?: string;
  backgroundColor?: string;
  fontFamily?: string;
  audience?: StatusAudience;
}

type ViewerWithUser = StatusViewer & { user?: StatusAuthor };

interface ViewersResponse {
  viewers: ViewerWithUser[];
}

interface StatusState {
  groups: StatusGroup[];
  myStatus: Status[];

  loading: boolean;
  refreshing: boolean;
  hasFetchedOnce: boolean;
  error: string | null;

  // Actions
  fetchFeed: (opts?: { refresh?: boolean }) => Promise<void>;
  createStatus: (input: CreateStatusInput) => Promise<Status>;
  markViewed: (statusId: string) => Promise<void>;
  deleteStatus: (statusId: string) => Promise<void>;
  getViewers: (statusId: string) => Promise<ViewerWithUser[]>;

  // Realtime handlers (called from useRealtimeStatus)
  applyStatusCreated: (status: Status, author?: StatusAuthor, currentUserId?: string) => void;
  applyStatusViewed: (statusId: string, viewerId: string, viewedAt: string) => void;
  applyStatusDeleted: (statusId: string, ownerId: string) => void;

  reset: () => void;
}

/**
 * The backend wraps every success body in `{ data: ... }` (see
 * `sendSuccessResponse`). This unwraps that envelope while tolerating an
 * already-unwrapped body, without resorting to `any`.
 */
function unwrap<T>(body: { data: T } | T): T {
  if (body && typeof body === 'object' && 'data' in body) {
    return (body as { data: T }).data;
  }
  return body as T;
}

function sortStatuses(list: Status[]): Status[] {
  return [...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

function recomputeGroupMeta(group: StatusGroup, currentUserId?: string): void {
  group.statuses = sortStatuses(group.statuses);
  const last = group.statuses[group.statuses.length - 1];
  group.lastCreatedAt = last?.createdAt || group.lastCreatedAt;
  group.hasUnviewed = currentUserId
    ? group.statuses.some(
        (s) => !s.viewedByMe && !(s.viewers || []).some((v) => v.userId === currentUserId)
      )
    : group.statuses.some((s) => !s.viewedByMe);
}

function sortGroups(groups: StatusGroup[]): StatusGroup[] {
  return [...groups].sort((a, b) => (a.lastCreatedAt < b.lastCreatedAt ? 1 : -1));
}

export const useStatusStore = create<StatusState>()(
  immer((set, get) => ({
    groups: [],
    myStatus: [],
    loading: false,
    refreshing: false,
    hasFetchedOnce: false,
    error: null,

    fetchFeed: async (opts) => {
      const refresh = Boolean(opts?.refresh);
      const hasData = get().groups.length > 0 || get().myStatus.length > 0 || get().hasFetchedOnce;
      if (refresh) {
        set({ refreshing: true, error: null });
      } else {
        set({ loading: !hasData, error: null });
      }
      try {
        type FeedPayload = { groups: StatusGroup[]; myStatus: Status[] };
        const response = await api.get<{ data: FeedPayload } | FeedPayload>('/status');
        const payload = unwrap<FeedPayload>(response.data) || { groups: [], myStatus: [] };
        const groups = sortGroups(
          (payload.groups || []).map((g) => ({
            ...g,
            statuses: sortStatuses(g.statuses || []),
          }))
        );
        const myStatus = sortStatuses(payload.myStatus || []);

        set({
          groups,
          myStatus,
          loading: false,
          refreshing: false,
          hasFetchedOnce: true,
          error: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to fetch status feed';
        console.error('[StatusStore] fetchFeed failed:', error);
        set({
          loading: false,
          refreshing: false,
          hasFetchedOnce: true,
          error: message,
        });
      }
    },

    createStatus: async (input) => {
      const response = await api.post<{ data: Status } | Status>('/status', input);
      const created = unwrap<Status>(response.data);

      set((state) => {
        state.myStatus.push(created);
        state.myStatus = sortStatuses(state.myStatus);
      });

      return created;
    },

    markViewed: async (statusId) => {
      try {
        await api.post(`/status/${statusId}/view`);
      } catch (error) {
        // Best-effort — viewing should never break the UI.
        console.warn('[StatusStore] markViewed failed:', error);
        return;
      }

      // Optimistically flip `viewedByMe` for the local copy.
      set((state) => {
        for (const group of state.groups) {
          const target = group.statuses.find((s) => s.id === statusId);
          if (target) {
            target.viewedByMe = true;
            recomputeGroupMeta(group);
            break;
          }
        }
      });
    },

    deleteStatus: async (statusId) => {
      await api.delete(`/status/${statusId}`);
      set((state) => {
        state.myStatus = state.myStatus.filter((s) => s.id !== statusId);
        state.groups = state.groups
          .map((g) => ({
            ...g,
            statuses: g.statuses.filter((s) => s.id !== statusId),
          }))
          .filter((g) => g.statuses.length > 0);
      });
    },

    getViewers: async (statusId) => {
      const response = await api.get<{ data: ViewersResponse } | ViewersResponse>(
        `/status/${statusId}/viewers`
      );
      const payload = unwrap<ViewersResponse>(response.data);
      return payload?.viewers || [];
    },

    applyStatusCreated: (status, author, currentUserId) => {
      set((state) => {
        if (status.userId === currentUserId) {
          if (!state.myStatus.some((s) => s.id === status.id)) {
            state.myStatus.push(status);
            state.myStatus = sortStatuses(state.myStatus);
          }
          return;
        }

        const existing = state.groups.find((g) => g.userId === status.userId);
        if (existing) {
          if (!existing.statuses.some((s) => s.id === status.id)) {
            existing.statuses.push(status);
            recomputeGroupMeta(existing, currentUserId);
          }
        } else {
          state.groups.push({
            userId: status.userId,
            author,
            statuses: [status],
            lastCreatedAt: status.createdAt,
            hasUnviewed: true,
          });
        }
        state.groups = sortGroups(state.groups);
      });
    },

    applyStatusViewed: (statusId, viewerId, viewedAt) => {
      set((state) => {
        for (const s of state.myStatus) {
          if (s.id === statusId) {
            if (!s.viewers.some((v) => v.userId === viewerId)) {
              s.viewers.push({ userId: viewerId, viewedAt });
            }
            return;
          }
        }
      });
    },

    applyStatusDeleted: (statusId) => {
      set((state) => {
        state.myStatus = state.myStatus.filter((s) => s.id !== statusId);
        state.groups = state.groups
          .map((g) => ({
            ...g,
            statuses: g.statuses.filter((s) => s.id !== statusId),
          }))
          .filter((g) => g.statuses.length > 0);
      });
    },

    reset: () => {
      set({
        groups: [],
        myStatus: [],
        loading: false,
        refreshing: false,
        hasFetchedOnce: false,
        error: null,
      });
    },
  }))
);

/**
 * Selectors
 */
export const selectStatusGroups = (state: StatusState) => state.groups;
export const selectMyStatus = (state: StatusState) => state.myStatus;
export const selectStatusLoading = (state: StatusState) => state.loading;
