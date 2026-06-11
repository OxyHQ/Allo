import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from '@/utils/api';
import { getMessagingSocket } from '@/hooks/useRealtimeMessaging';
import { usePresenceStore, type PresenceEntry } from '@/stores/presenceStore';

/** Wire event name; must match the backend `PRESENCE_EVENT`. */
const PRESENCE_EVENT = 'presence:update';

/** Cap on bootstrap ids per request; mirrors the backend `MAX_PRESENCE_BOOTSTRAP_IDS`. */
const MAX_BOOTSTRAP_IDS = 100;

/** Raw `presence:update` payload from the server. */
interface PresenceUpdatePayload {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
}

/**
 * Apply a raw `presence:update` event to the store. Exported for unit testing
 * the listener's mapping without a live socket. Ignores malformed payloads.
 */
export function applyPresenceEvent(payload: PresenceUpdatePayload | undefined): void {
  if (!payload || typeof payload.userId !== 'string') {
    return;
  }
  usePresenceStore
    .getState()
    .setPresence(payload.userId, Boolean(payload.online), payload.lastSeenAt ?? null);
}

/**
 * Tracks which socket instance currently has the `presence:update` listener
 * attached, so wiring is idempotent across hook mounts and survives reconnects
 * (a reconnect mints a new socket id, re-triggering the wire).
 */
let presenceListenerSocketId: string | null = null;
/** The socket instance we've attached a `connect` re-wire handler to. */
let presenceConnectWiredSocket: Socket | null = null;

/**
 * Attach the shared `presence:update` listener to a socket exactly once per
 * socket instance. Removes any prior handler first so re-entry never stacks
 * duplicate listeners on the same socket.
 */
function wirePresenceListener(socket: Socket): void {
  // `socket.id` is only defined once connected; bail until then.
  const socketId = socket.id;
  if (!socketId || presenceListenerSocketId === socketId) {
    return;
  }
  socket.off(PRESENCE_EVENT);
  socket.on(PRESENCE_EVENT, (payload: PresenceUpdatePayload) => applyPresenceEvent(payload));
  presenceListenerSocketId = socketId;
}

/**
 * Ensure the presence listener is wired to the current shared messaging socket.
 * If the socket exists, wire immediately. Also attach a one-time `connect`
 * handler so a later (re)connect — which produces a new socket id — re-wires the
 * listener. Both paths are idempotent.
 */
function ensurePresenceWired(): void {
  const socket = getMessagingSocket();
  if (!socket) {
    return;
  }
  if (socket.connected) {
    wirePresenceListener(socket);
  }
  // Re-wire on (re)connect. The connection may not be established yet, or may
  // drop and reconnect with a fresh id; this keeps the listener attached.
  if (presenceConnectWiredSocket !== socket) {
    socket.on('connect', () => wirePresenceListener(socket));
    presenceConnectWiredSocket = socket;
  }
}

/**
 * Unwrap the backend success envelope. `sendSuccessResponse` wraps payloads as
 * `{ data: <payload> }`; tolerate a flat payload too for forward-compatibility.
 */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  return body as T;
}

/** Normalize, de-duplicate and cap a list of user ids for a bootstrap request. */
function normalizeIds(userIds: string[]): string[] {
  const seen = new Set<string>();
  for (const id of userIds) {
    if (typeof id === 'string' && id.length > 0) {
      seen.add(id);
    }
    if (seen.size >= MAX_BOOTSTRAP_IDS) {
      break;
    }
  }
  return Array.from(seen);
}

/**
 * Subscribe a surface to presence for the given user ids.
 *
 * Two responsibilities, both keyed on a stable sorted-ids string so the effect
 * only re-runs when the watched set actually changes:
 *  1. Bootstrap current presence via `GET /presence?userIds=...` and merge it
 *     into the store, so dots/last-seen are correct before the first live event.
 *  2. Ensure the shared `presence:update` listener is attached to the messaging
 *     socket (idempotent; re-wires on reconnect).
 *
 * Components read presence via the `usePresence(userId)` store selector. The
 * shared socket listener is intentionally NOT torn down on unmount — the socket
 * is app-lifecycle and other mounted surfaces rely on the same listener; the
 * per-socket-id guard prevents duplicates.
 */
export function useSubscribePresence(userIds: string[]): void {
  const idsKey = normalizeIds(userIds).slice().sort().join(',');

  useEffect(() => {
    ensurePresenceWired();

    const ids = idsKey ? idsKey.split(',') : [];
    if (ids.length === 0) {
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await api.get<unknown>('/presence', { userIds: ids.join(',') });
        if (cancelled) return;
        const entries = unwrap<Record<string, PresenceEntry>>(res.data);
        if (entries && typeof entries === 'object') {
          usePresenceStore.getState().setMany(entries);
        }
      } catch (error) {
        console.warn('[Presence] Failed to bootstrap presence:', error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [idsKey]);
}
