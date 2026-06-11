/**
 * useCallSignaling — mounts a Socket.IO connection to the `/messaging`
 * namespace and pipes WebRTC signaling events into the calls store.
 *
 * Mounted once at the app layout level. Socket.IO multiplexes per-namespace,
 * so reusing `/messaging` (the existing real-time channel) avoids the cost
 * and auth duplication of an additional connection.
 */
import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useOxy } from '@oxyhq/services';
import { oxyClient } from '@oxyhq/core';
import { API_URL } from '@/config';
import { useCallsStore } from '@/stores/callsStore';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import type {
  CallIncomingEvent,
  CallAcceptedEvent,
  CallDeclinedEvent,
  CallCanceledEvent,
  CallEndedEvent,
  CallMissedEvent,
  CallSignalEvent,
  CallSignalBody,
  CallAnsweredElsewhereEvent,
} from '@allo/shared-types';

let callSignalingSocket: Socket | null = null;
let listenersBoundForSocketId: string | null = null;

/**
 * Tear down the module-level call-signaling socket and unbind it from the calls
 * store. Exported for session cleanup (logout / account switch); the hook's
 * connect effect (keyed on `[isAuthenticated, user?.id]`) re-creates it for the
 * next session.
 */
export function disconnectCallSignalingSocket(): void {
  if (callSignalingSocket) {
    callSignalingSocket.removeAllListeners();
    callSignalingSocket.disconnect();
    callSignalingSocket = null;
  }
  listenersBoundForSocketId = null;
  // Drop the signal sender so the calls store can't emit over a dead socket.
  useCallsStore.getState()._setSignalSender(null);
}

function buildSocketUrl(): string {
  let url = API_URL || process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';
  url = url.replace('/api', '').replace('https://', 'wss://').replace('http://', 'ws://');
  return url;
}

interface AckResponse {
  ok: boolean;
  callId?: string;
  error?: string;
}

function emitWithAck<T extends AckResponse>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = 10_000
): Promise<T> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: 'Signaling timeout' } as T);
    }, timeoutMs);
    socket.emit(event, payload, (resp: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(resp ?? ({ ok: false, error: 'No response' } as T));
    });
  });
}

export function useCallSignaling() {
  const { isAuthenticated, user } = useOxy();
  const userIdRef = useRef<string | undefined>(user?.id);
  userIdRef.current = user?.id;
  // Subscribe to the resolved device id so the connect effect re-runs once
  // device keys initialize (a socket opened before keys exist reconnects with
  // the deviceId, joining its device room for precise call-event targeting).
  const ownDeviceId = useDeviceKeysStore((state) => state.deviceKeys?.deviceId);

  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;

    const token = oxyClient.getAccessToken();
    if (!token) {
      // Token not ready yet; effect will re-run once auth resolves.
      return;
    }

    // (Re)create the socket if it's missing, disconnected, or was opened before
    // the device id was known (so it can rejoin with its device room). The
    // deviceId is included in the handshake so the server joins this connection
    // to `device:{userId}:{id}` and can target/exclude it precisely for
    // `call:answered-elsewhere`. When device keys aren't initialized yet it is
    // omitted (legacy-style connect, accepted by the server; the effect re-runs
    // once keys resolve and reconnects with the id).
    const socketDeviceId = (callSignalingSocket?.auth as { deviceId?: number } | undefined)
      ?.deviceId;
    const needsReconnectForDevice =
      !!callSignalingSocket && ownDeviceId !== undefined && socketDeviceId !== ownDeviceId;
    if (!callSignalingSocket || !callSignalingSocket.connected || needsReconnectForDevice) {
      callSignalingSocket?.disconnect();
      callSignalingSocket = io(`${buildSocketUrl()}/messaging`, {
        auth: { token, userId: user.id, deviceId: ownDeviceId },
        transports: ['websocket'],
        path: '/socket.io',
        reconnectionAttempts: 15,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10_000,
        timeout: 10_000,
      });
    }

    const socket = callSignalingSocket;

    const bindStoreSender = () => {
      useCallsStore.getState()._setSignalSender({
        sendInvite: async ({ calleeId, type, conversationId }) => {
          if (!socket.connected) return { ok: false, error: 'Not connected' };
          return emitWithAck<AckResponse>(socket, 'call:invite', {
            calleeId,
            type,
            conversationId,
          });
        },
        sendAccept: (callId) =>
          socket.connected
            ? emitWithAck<AckResponse>(socket, 'call:accept', { callId })
            : Promise.resolve({ ok: false, error: 'Not connected' }),
        sendDecline: (callId) =>
          socket.connected
            ? emitWithAck<AckResponse>(socket, 'call:decline', { callId })
            : Promise.resolve({ ok: false, error: 'Not connected' }),
        sendCancel: (callId) =>
          socket.connected
            ? emitWithAck<AckResponse>(socket, 'call:cancel', { callId })
            : Promise.resolve({ ok: false, error: 'Not connected' }),
        sendEnd: (callId) =>
          socket.connected
            ? emitWithAck<AckResponse>(socket, 'call:end', { callId })
            : Promise.resolve({ ok: false, error: 'Not connected' }),
        sendSignal: (callId, to, payload) =>
          socket.connected
            ? emitWithAck<AckResponse>(socket, 'call:signal', { callId, to, payload })
            : Promise.resolve({ ok: false, error: 'Not connected' }),
      });
    };

    const bindListeners = () => {
      if (listenersBoundForSocketId === socket.id) return;

      socket.off('call:incoming');
      socket.off('call:accepted');
      socket.off('call:declined');
      socket.off('call:canceled');
      socket.off('call:ended');
      socket.off('call:missed');
      socket.off('call:answered-elsewhere');
      socket.off('call:signal');

      socket.on('call:incoming', (evt: CallIncomingEvent) => {
        useCallsStore.getState().onIncoming(evt);
      });
      socket.on('call:accepted', (evt: CallAcceptedEvent) => {
        void useCallsStore.getState().onAccepted(evt);
      });
      socket.on('call:declined', (evt: CallDeclinedEvent) => {
        useCallsStore.getState().onDeclined(evt);
      });
      socket.on('call:canceled', (evt: CallCanceledEvent) => {
        useCallsStore.getState().onCanceled(evt);
      });
      socket.on('call:ended', (evt: CallEndedEvent) => {
        useCallsStore.getState().onEnded(evt);
      });
      socket.on('call:missed', (evt: CallMissedEvent) => {
        useCallsStore.getState().onMissed(evt);
      });
      socket.on('call:answered-elsewhere', (evt: CallAnsweredElsewhereEvent) => {
        useCallsStore.getState().onAnsweredElsewhere(evt);
      });
      socket.on('call:signal', (evt: CallSignalEvent<CallSignalBody>) => {
        void useCallsStore.getState().onSignal(evt);
      });

      listenersBoundForSocketId = socket.id ?? null;
    };

    const onConnect = () => {
      bindStoreSender();
      bindListeners();
    };

    const onDisconnect = () => {
      if (listenersBoundForSocketId === socket.id) {
        listenersBoundForSocketId = null;
      }
      // A CONNECTED call's media is peer-to-peer and survives signaling blips
      // (Socket.IO auto-reconnects; real media loss is caught by ICE failure).
      // But a call still setting up (ringing/connecting) depends on signaling, so
      // `onConnectionLost` tears down only those — it preserves connected calls.
      useCallsStore.getState().onConnectionLost();
    };

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', (err) => {
      console.warn('[CallSignaling] connect_error', err?.message || err);
    });

    if (socket.connected) {
      onConnect();
    }

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      // Do NOT disconnect the module-level socket here — the calls store needs
      // it to survive screen transitions. It is torn down explicitly on logout
      // via `disconnectCallSignalingSocket`.
    };
  }, [isAuthenticated, user?.id, ownDeviceId]);
}

/** Standalone helper for screens that need to start a call without holding the hook. */
export function getCallSignalingSocket(): Socket | null {
  return callSignalingSocket;
}
