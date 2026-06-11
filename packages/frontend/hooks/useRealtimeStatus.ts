import { useEffect } from 'react';
import type { Socket } from 'socket.io-client';
import { useOxy } from '@oxyhq/services';
import { getMessagingSocket } from '@/hooks/useRealtimeMessaging';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import { useStatusStore, Status, StatusAuthor } from '@/stores/statusStore';

/**
 * Realtime hook for Status (WhatsApp-style Stories).
 *
 * Status events ride the SAME shared `/messaging` socket as messaging and
 * presence — we attach listeners to the single app-lifecycle connection
 * (`getMessagingSocket`) rather than opening a second socket per mount. Opening
 * a dedicated socket re-triggered the server's presence-audience DB queries on
 * every status-screen mount; reusing the shared socket avoids that entirely.
 *
 * Mounted once at the `(chat)` layout level so `statusCreated` is applied to the
 * store even when the user is not on the status screen. The wiring is idempotent
 * (guarded per socket id and re-wired on reconnect), so a second mount — e.g. if
 * the status screen also calls this hook — never stacks duplicate listeners.
 */

const STATUS_CREATED_EVENT = 'statusCreated';
const STATUS_VIEWED_EVENT = 'statusViewed';
const STATUS_DELETED_EVENT = 'statusDeleted';

interface StatusCreatedPayload {
  status: Status;
  author?: StatusAuthor;
}

interface StatusViewedPayload {
  statusId: string;
  ownerId: string;
  viewerId: string;
  viewedAt: string;
}

interface StatusDeletedPayload {
  statusId: string;
  ownerId: string;
}

/**
 * Tracks which socket instance currently has the status listeners attached, so
 * wiring is idempotent across hook mounts and survives reconnects (a reconnect
 * mints a new socket id, re-triggering the wire).
 */
let statusListenerSocketId: string | null = null;
/** The socket instance we've attached a `connect` re-wire handler to. */
let statusConnectWiredSocket: Socket | null = null;

/**
 * Attach the shared status listeners to a socket exactly once per socket
 * instance. Removes any prior handlers first so re-entry never stacks duplicate
 * listeners on the same socket. `currentUserId` is read at wire time to route
 * own-vs-others events correctly.
 */
function wireStatusListeners(socket: Socket, currentUserId: string): void {
  const socketId = socket.id;
  if (!socketId || statusListenerSocketId === socketId) {
    return;
  }

  socket.off(STATUS_CREATED_EVENT);
  socket.off(STATUS_VIEWED_EVENT);
  socket.off(STATUS_DELETED_EVENT);

  const store = useStatusStore.getState();

  socket.on(STATUS_CREATED_EVENT, (payload: StatusCreatedPayload) => {
    if (!payload?.status) return;
    store.applyStatusCreated(payload.status, payload.author, currentUserId);
  });

  socket.on(STATUS_VIEWED_EVENT, (payload: StatusViewedPayload) => {
    if (!payload?.statusId || !payload?.viewerId) return;
    // Only relevant when the current user is the owner of the viewed status.
    if (payload.ownerId !== currentUserId) return;
    store.applyStatusViewed(payload.statusId, payload.viewerId, payload.viewedAt);
  });

  socket.on(STATUS_DELETED_EVENT, (payload: StatusDeletedPayload) => {
    if (!payload?.statusId) return;
    store.applyStatusDeleted(payload.statusId, payload.ownerId);
  });

  statusListenerSocketId = socketId;
}

/**
 * Ensure the status listeners are wired to the current shared messaging socket.
 * If the socket exists and is connected, wire immediately. Also attach a
 * one-time `connect` handler so a later (re)connect — which produces a new
 * socket id — re-wires the listeners. Both paths are idempotent.
 *
 * Exported for unit-testing the wiring without rendering the hook.
 */
export function ensureStatusWired(currentUserId: string): void {
  const socket = getMessagingSocket();
  if (!socket) {
    return;
  }
  if (socket.connected) {
    wireStatusListeners(socket, currentUserId);
  }
  if (statusConnectWiredSocket !== socket) {
    socket.on('connect', () => wireStatusListeners(socket, currentUserId));
    statusConnectWiredSocket = socket;
  }
}

/**
 * Subscribe the app to realtime status events on the shared messaging socket.
 * Listeners are intentionally NOT torn down on unmount — the socket is
 * app-lifecycle and the per-socket-id guard prevents duplicates. Logout/account
 * switch tears the socket down via `disconnectMessagingSocket`; the next connect
 * produces a fresh socket id that re-wires these listeners.
 */
export function useRealtimeStatus(): void {
  const { user, isAuthenticated } = useOxy();
  const userId = user?.id;
  // The shared messaging socket only connects once Signal device keys are ready
  // (it gates the handshake on the device id). Subscribing here re-runs this
  // effect at that moment, so we wire onto the socket as soon as it exists; the
  // `connect` re-wire handler then covers the actual (re)connect transition.
  const ownDeviceId = useDeviceKeysStore((state) => state.deviceKeys?.deviceId);

  useEffect(() => {
    if (!isAuthenticated || !userId || !ownDeviceId) {
      return;
    }
    ensureStatusWired(userId);
  }, [isAuthenticated, userId, ownDeviceId]);
}
