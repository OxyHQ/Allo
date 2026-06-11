/**
 * useP2PMessaging — owns a dedicated Socket.IO connection to the `/messaging`
 * namespace for WebRTC P2P signaling, and bridges incoming data-channel
 * payloads into the messages store.
 *
 * Mirrors `useCallSignaling`: mounted once at the chat layout level so the
 * socket survives screen transitions, and reused across re-renders.
 *
 * Why a separate socket from `useRealtimeMessaging` / `useCallSignaling`?
 * Each hook is self-contained and owns its own listeners. Socket.IO will
 * multiplex transparently at the transport layer, and a separate connection
 * keeps the event surface area cleanly partitioned (and avoids stomping on
 * the call-signaling singleton when the user opens/closes chat screens).
 */

import { useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { useOxy } from '@oxyhq/services';
import { oxyClient } from '@oxyhq/core';
import { API_URL } from '@/config';
import { p2pManager, type P2PMessageEnvelope } from '@/lib/p2pMessaging';
import { useMessagesStore, type Message } from '@/stores/messagesStore';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';

let p2pSocket: Socket | null = null;
let removeMessageHandler: (() => void) | null = null;
let evictInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Tear down the module-level P2P socket, the message-bridge handler, the idle
 * eviction timer, and every active peer session. Exported for session cleanup
 * (logout / account switch); the hook's connect effect (keyed on
 * `[isAuthenticated, user?.id]`) re-establishes everything for the next session.
 */
export function disconnectP2PSocket(): void {
  if (removeMessageHandler) {
    removeMessageHandler();
    removeMessageHandler = null;
  }
  if (evictInterval) {
    clearInterval(evictInterval);
    evictInterval = null;
  }
  // Close every WebRTC peer session and clear the manager's identity so no P2P
  // state survives into the next account.
  p2pManager.reset();
  if (p2pSocket) {
    p2pSocket.removeAllListeners();
    p2pSocket.disconnect();
    p2pSocket = null;
  }
}

function buildSocketUrl(): string {
  let url = API_URL || process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';
  url = url.replace('/api', '').replace('https://', 'wss://').replace('http://', 'ws://');
  return url;
}

/**
 * Decode an inbound envelope into a `Message`, decrypting via Signal when
 * needed. Mirrors the relay path in `useRealtimeMessaging`'s `newMessage`
 * handler — kept compact here since DC payloads are always from a single
 * peer (no group fan-out) and never contain attachments.
 */
async function envelopeToMessage(
  envelope: P2PMessageEnvelope,
  currentUserId: string | undefined
): Promise<Message | null> {
  // Defence-in-depth: a peer claiming to be us is a no-op.
  if (currentUserId && envelope.senderId === currentUserId) {
    return null;
  }

  let text = '';
  let isEncrypted = false;

  if (envelope.isEncrypted && envelope.ciphertext) {
    isEncrypted = true;
    try {
      text = await useDeviceKeysStore.getState().decryptMessageFromSender(
        envelope.ciphertext,
        envelope.senderId,
        envelope.senderDeviceId
      );
      isEncrypted = false;
    } catch (err) {
      console.error('[P2PMessaging] decrypt failed:', err);
      const errMsg = err instanceof Error ? err.message : '';
      text = errMsg.includes('[Mensaje no descifrable]')
        ? '[Mensaje no descifrable]'
        : '[Encrypted - Decryption failed]';
      isEncrypted = true;
    }
  } else if (envelope.text) {
    text = envelope.text;
  } else {
    return null;
  }

  const timestamp = (() => {
    const t = new Date(envelope.timestamp);
    return Number.isNaN(t.getTime()) ? new Date() : t;
  })();

  return {
    id: envelope.clientMessageId,
    text,
    senderId: envelope.senderId,
    senderDeviceId: envelope.senderDeviceId,
    timestamp,
    isSent: false,
    conversationId: envelope.conversationId,
    fontSize: envelope.fontSize,
    isEncrypted,
    readStatus: undefined,
    messageType: 'user',
    ...(envelope.ciphertext ? { ciphertext: envelope.ciphertext } : {}),
  };
}

export function useP2PMessaging() {
  const { isAuthenticated, user } = useOxy();
  // Reactive: device keys may initialize AFTER the socket connects, so we track
  // the device id here and push it into the manager whenever it changes (below).
  const ownDeviceId = useDeviceKeysStore((state) => state.deviceKeys?.deviceId);

  // Keep the P2P manager's `selfDeviceId` in sync with this device's Signal id so
  // device-addressed history transfer (Fase 1C) always targets the right peer
  // device — even if keys initialized after the connection was established.
  useEffect(() => {
    if (ownDeviceId === undefined) return;
    p2pManager.setSelfDeviceId(ownDeviceId);
  }, [ownDeviceId]);

  useEffect(() => {
    if (!isAuthenticated || !user?.id) return;

    const token = oxyClient.getAccessToken();
    if (!token) return;

    if (!p2pSocket || !p2pSocket.connected) {
      p2pSocket?.disconnect();
      p2pSocket = io(`${buildSocketUrl()}/messaging`, {
        auth: { token, userId: user.id },
        transports: ['websocket'],
        path: '/socket.io',
        reconnectionAttempts: 15,
        reconnectionDelay: 2000,
        reconnectionDelayMax: 10_000,
        timeout: 10_000,
      });
    }
    const socket = p2pSocket;
    const currentUserId = user.id;

    const wireUp = () => {
      // Read the freshest device id at connect time (the closure deps don't track
      // it; the dedicated effect above keeps it in sync afterwards). Undefined
      // before key init — that case is covered once keys initialize.
      const deviceId = useDeviceKeysStore.getState().deviceKeys?.deviceId;
      p2pManager.init(socket, currentUserId, deviceId);
    };

    const onConnect = () => wireUp();
    socket.on('connect', onConnect);
    socket.on('connect_error', (err) => {
      console.warn('[P2PMessaging] connect_error', err?.message || err);
    });

    if (socket.connected) {
      wireUp();
    }

    // Bridge incoming DC payloads → messagesStore.
    if (removeMessageHandler) {
      removeMessageHandler();
      removeMessageHandler = null;
    }
    removeMessageHandler = p2pManager.onMessage(async ({ from, payload }) => {
      // Trust boundary: ignore envelopes where the wire-level peer doesn't
      // match the claimed sender. The signaling layer authenticates the
      // socket identity, so `from` is server-attested.
      if (payload.senderId !== from) {
        console.warn('[P2PMessaging] dropping envelope with mismatched sender');
        return;
      }

      // O(1) dedup by clientMessageId (matches the relay-path pattern).
      const idSet =
        useMessagesStore.getState().messageIdsByConversation[payload.conversationId];
      if (idSet?.has(payload.clientMessageId)) {
        return;
      }

      const msg = await envelopeToMessage(payload, currentUserId);
      if (!msg) return;
      try {
        await useMessagesStore.getState().addMessage(msg);
      } catch (err) {
        console.error('[P2PMessaging] addMessage failed:', err);
      }
    });

    // Idle eviction every minute.
    if (!evictInterval) {
      evictInterval = setInterval(() => {
        p2pManager.evictIdleSessions();
      }, 60_000);
    }

    return () => {
      socket.off('connect', onConnect);
      // Keep the socket and the P2PManager wired across screen transitions;
      // the singleton survives until the user logs out / app unmounts.
    };
  }, [isAuthenticated, user?.id]);
}
