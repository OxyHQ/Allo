import { useEffect, useCallback, useRef } from 'react';
import { useOxy } from '@oxyhq/services';
import { oxyClient } from '@oxyhq/core';
import { io, Socket } from 'socket.io-client';
import { API_URL } from '@/config';
import { api } from '@/utils/api';
import { useMessagesStore, applyDecryptedBody } from '@/stores/messagesStore';
import { useConversationsStore } from '@/stores/conversationsStore';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import { bumpDeviceListRefresh } from '@/stores/deviceListRefreshStore';
import { useUsersStore } from '@/stores/usersStore';
import type { Message, DecryptedBodyFields } from '@/stores/messagesStore';

let messagingSocket: Socket | null = null;
const typingUsers: Map<string, Set<string>> = new Map(); // conversationId -> Set of userIds
let listenersInitializedSocketId: string | null = null; // Track which socket instance has listeners set up

/** Debounce window for coalescing conversation-list refreshes (ms). */
const CONVERSATION_REFRESH_DEBOUNCE_MS = 1500;
let conversationRefreshTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Coalesce bursts of `conversationActivity` events into a single conversation
 * list refresh so unread badges reconcile with the server-authoritative counts
 * without one network call per event (cheap for group chats).
 */
function scheduleConversationRefresh(): void {
  if (conversationRefreshTimer) return;
  conversationRefreshTimer = setTimeout(() => {
    conversationRefreshTimer = null;
    void useConversationsStore.getState().fetchConversations();
  }, CONVERSATION_REFRESH_DEBOUNCE_MS);
}

/**
 * Tear down the module-level messaging socket and reset all associated global
 * state. Exported so session cleanup (logout / account switch) can fully sever
 * the connection — the connect-on-login effect (keyed on `[isAuthenticated,
 * user?.id]`) re-establishes it for the next session.
 */
export function disconnectMessagingSocket(): void {
  if (messagingSocket) {
    messagingSocket.removeAllListeners();
    messagingSocket.disconnect();
    messagingSocket = null;
  }
  listenersInitializedSocketId = null;
  typingUsers.clear();
  // Cancel any pending coalesced refresh so it can't fire after logout and hit
  // freshly-reset stores with the previous session's token (cross-user leak).
  if (conversationRefreshTimer) {
    clearTimeout(conversationRefreshTimer);
    conversationRefreshTimer = null;
  }
}

/**
 * Accessor for the shared module-level messaging socket. Other hooks (e.g.
 * presence) attach their own listeners to this single connection rather than
 * opening a second socket. Returns null until the connect effect establishes it.
 */
export function getMessagingSocket(): Socket | null {
  return messagingSocket;
}

/** Raw realtime `newMessage` / `messageUpdated` payload (device-addressed). */
export interface IncomingMessagePayload {
  _id?: string;
  id?: string;
  conversationId: string;
  senderId: string;
  senderDeviceId?: number;
  text?: string;
  ciphertext?: string | null;
  fontSize?: number;
  createdAt: string;
  /** Set on `messageUpdated` (edit) payloads. */
  updatedAt?: string;
  sticker?: Message['sticker'];
  messageType?: string;
  readBy?: Record<string, string>;
  deliveredTo?: string[];
}

/** Socket.IO handshake auth carried on the `/messaging` connection. */
interface SocketAuth {
  token?: string;
  userId?: string;
  deviceId?: number;
}

/** Read the current socket's handshake auth in a typed way (no `as any`). */
function getSocketAuth(): SocketAuth {
  return (messagingSocket?.auth as SocketAuth | undefined) ?? {};
}

/** Handshake-rejection message the server sends for a revoked/unknown device. */
const UNREGISTERED_DEVICE_ERROR = 'unregistered_device';

/**
 * Handle a `/messaging` `connect_error`. The server rejects a revoked device at
 * the handshake with `unregistered_device`; since the connection never
 * establishes, the `device:revoked` push can't arrive, so without self-healing
 * the client exhausts its reconnect attempts and gets permanently stuck.
 *
 * On that specific error we re-key this device (idempotent — `handleRevocation`
 * has its own in-flight guard) and tear down the doomed socket. Re-initialization
 * mints a fresh device id, which the reactive `ownDeviceId` selector picks up so
 * the connect effect reconnects with the new identity. Exported for unit testing.
 */
export function handleMessagingConnectError(error: Error | undefined): void {
  console.error('[RealtimeMessaging] Socket connection error:', error);
  if (error?.message === UNREGISTERED_DEVICE_ERROR) {
    console.warn('[RealtimeMessaging] Device unregistered server-side; re-keying and reconnecting');
    void useDeviceKeysStore.getState().handleRevocation();
    disconnectMessagingSocket();
  }
}

/** Outcome of processing an incoming realtime message. */
export interface IncomingMessageResult {
  /** True when this device authored the message (skip — already added locally). */
  skip: boolean;
  /** The built Message, or null when skipped. */
  message: Message | null;
  /** True when an encrypted payload was successfully decrypted. */
  decryptionSucceeded: boolean;
}

/**
 * Build a local Message from a realtime `newMessage` payload, decrypting when
 * needed. Exported (and dependency-injected) so the multi-device behavior is
 * unit-testable without rendering the hook.
 *
 * Multi-device rule: skip ONLY messages authored by THIS device. A message from
 * one of our OTHER devices (sent-message sync) is decrypted normally — the other
 * device encrypted an envelope to us — and marked `isSent: true`.
 */
export async function buildIncomingMessage(
  messageData: IncomingMessagePayload,
  currentUserId: string | undefined,
  ownDeviceId: number | undefined,
  decrypt: (ciphertext: string, senderUserId: string, senderDeviceId: number) => Promise<string>
): Promise<IncomingMessageResult> {
  const isOwnMessage = !!(currentUserId && messageData.senderId === currentUserId);

  if (isOwnMessage && ownDeviceId !== undefined && messageData.senderDeviceId === ownDeviceId) {
    return { skip: true, message: null, decryptionSucceeded: false };
  }

  let decryptedText = messageData.text;
  let isEncrypted = false;
  let decryptionSucceeded = false;

  if (messageData.ciphertext && messageData.senderId && messageData.senderDeviceId) {
    isEncrypted = true;
    try {
      decryptedText = await decrypt(
        messageData.ciphertext,
        messageData.senderId,
        messageData.senderDeviceId
      );
      isEncrypted = false;
      decryptionSucceeded = true;
    } catch (error) {
      console.error('[RealtimeMessaging] Error decrypting message:', error);
      decryptedText = '[Encrypted - Decryption failed]';
      isEncrypted = true;
    }
  } else if (messageData.text) {
    decryptedText = messageData.text;
    isEncrypted = false;
  } else {
    decryptedText = '[Media or invalid message]';
  }

  // Sender-side read status (only meaningful for messages we authored).
  let readStatus: 'pending' | 'sent' | 'delivered' | 'read' | undefined;
  if (isOwnMessage) {
    const recipientRead =
      messageData.readBy && typeof messageData.readBy === 'object'
        ? Object.keys(messageData.readBy).some((id) => id !== currentUserId)
        : false;
    if (recipientRead) {
      readStatus = 'read';
    } else if (Array.isArray(messageData.deliveredTo)) {
      readStatus = messageData.deliveredTo.some((id) => id !== currentUserId) ? 'delivered' : 'sent';
    } else {
      readStatus = 'sent';
    }
  }

  // On a successful decrypt the plaintext body may be a versioned attachment
  // payload (carrying the caption + key-bearing media refs, or a structured
  // location / contact card). `applyDecryptedBody` reconstructs `text` / `media` /
  // `attachmentType` / `location` / `contact` from it (and returns plain text
  // verbatim otherwise) so live-delivered encrypted attachments render
  // immediately instead of showing raw JSON until a refetch.
  const body: DecryptedBodyFields = decryptionSucceeded
    ? applyDecryptedBody(decryptedText || '')
    : { text: decryptedText || '' };

  const message: Message = {
    id: messageData._id || messageData.id || '',
    text: body.text,
    senderId: messageData.senderId,
    senderDeviceId: messageData.senderDeviceId,
    timestamp: new Date(messageData.createdAt),
    isSent: isOwnMessage,
    conversationId: messageData.conversationId,
    fontSize: messageData.fontSize,
    isEncrypted,
    readStatus,
    ...(body.media ? { media: body.media } : {}),
    ...(body.attachmentType ? { attachmentType: body.attachmentType } : {}),
    ...(body.location ? { location: body.location } : {}),
    ...(body.contact ? { contact: body.contact } : {}),
    ...(messageData.ciphertext ? { ciphertext: messageData.ciphertext } : {}),
    ...(messageData.sticker ? { sticker: messageData.sticker } : {}),
    messageType: messageData.messageType === 'ai' ? 'ai' : 'user',
  };

  return { skip: false, message, decryptionSucceeded };
}

/**
 * Locate which conversation a message belongs to by scanning the message store.
 * Used for socket events (e.g. reactions) that only carry the message id.
 */
function findConversationIdForMessage(messageId: string): string | undefined {
  const byConversation = useMessagesStore.getState().messagesByConversation;
  for (const [conversationId, messages] of Object.entries(byConversation)) {
    if (messages.some((m) => m.id === messageId)) {
      return conversationId;
    }
  }
  return undefined;
}

/**
 * Hook for real-time messaging updates via Socket.IO
 * Handles:
 * - New messages
 * - Message updates (edits)
 * - Message deletions
 * - Typing indicators
 * - Read receipts
 */
export const useRealtimeMessaging = (conversationId?: string) => {
  const { user, isAuthenticated } = useOxy();
  const addMessage = useMessagesStore((state) => state.addMessage);
  const updateMessage = useMessagesStore((state) => state.updateMessage);
  const removeMessage = useMessagesStore((state) => state.removeMessage);
  const updateConversation = useConversationsStore((state) => state.updateConversation);
  const deviceKeysStore = useDeviceKeysStore();
  // Subscribe to our own device id so the connect effect re-runs once Signal
  // keys finish initializing (the socket handshake needs this device id).
  const ownDeviceId = useDeviceKeysStore((state) => state.deviceKeys?.deviceId);
  const typingTimeoutRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Set up event listeners (once per socket instance)
  const setupEventListeners = useCallback(() => {
    if (!messagingSocket || !messagingSocket.connected) {
      return;
    }

    // If listeners already set up for this socket instance, skip (prevents duplicate listeners)
    if (listenersInitializedSocketId === messagingSocket.id) {
      return;
    }

    // Remove old listeners if they exist on this socket (safety check)
    messagingSocket.off('newMessage');
    messagingSocket.off('conversationActivity');
    messagingSocket.off('messageUpdated');
    messagingSocket.off('messageDeleted');
    messagingSocket.off('messageReactionUpdated');
    messagingSocket.off('typing');
    messagingSocket.off('messageRead');
    messagingSocket.off('conversationThemeUpdated');
    messagingSocket.off('device:revoked');
    messagingSocket.off('deviceListChanged');
    messagingSocket.off('deviceIdentityChanged');
    messagingSocket.off('disconnect');
    messagingSocket.off('connect_error');

    // Handle new messages - this listener is set once globally and receives ALL messages
    // Messages come from both conversation rooms and user rooms (backend emits to both)
    messagingSocket.on('newMessage', async (messageData: IncomingMessagePayload) => {
      try {
        // Get current user ID dynamically from socket auth or useOxy store
        // This ensures we always have the correct user ID, even if it changes
        const currentUserId = getSocketAuth().userId || user?.id;
        const myDeviceId = useDeviceKeysStore.getState().deviceKeys?.deviceId;

        // O(1) dedup check via ID Set (WhatsApp/Telegram pattern)
        const messageId = messageData._id || messageData.id;
        if (!messageId) {
          console.warn('[RealtimeMessaging] Dropping newMessage with no id');
          return;
        }
        const idSet = useMessagesStore.getState().messageIdsByConversation[messageData.conversationId];
        if (idSet?.has(messageId)) {
          return;
        }

        // Build the local message (skip-check + decryption + read-status). For an
        // own-other-device message this decrypts our envelope and marks isSent.
        const { skip, message, decryptionSucceeded } = await buildIncomingMessage(
          messageData,
          currentUserId,
          myDeviceId,
          deviceKeysStore.decryptMessageFromSender
        );
        if (skip || !message) {
          return;
        }
        const decryptedText = message.text;

        // Acknowledge delivery of our envelope once we've successfully decrypted
        // (fire-and-forget; the X-Device-Id header identifies this device).
        if (decryptionSucceeded && messageId) {
          void api
            .post(`/messages/${messageId}/delivered`, {})
            .catch((error) => console.warn('[RealtimeMessaging] delivered ack failed:', error));
        }

        // Add message to store - this updates the conversation list immediately
        // Note: addMessage takes only the message (conversationId is in the message object)
        addMessage(message).catch((error) => {
          console.error('[RealtimeMessaging] Error adding message to store:', error);
        });

        // Update conversation last message and unread count
        // This ensures the conversation list shows the latest message instantly
        const currentConversation = useConversationsStore.getState().conversationsById[messageData.conversationId];
        const currentUnreadCount = currentConversation?.unreadCount || 0;
        
        // Format last message with sender name for groups (e.g., "Albert: Hello")
        // Use decrypted text, never show "[Encrypted]" if we successfully decrypted
        let formattedLastMessage: string;
        if (messageData.sticker) {
          // Sticker messages show emoji or "Sticker" in conversation list
          formattedLastMessage = messageData.sticker.emoji || 'Sticker';
        } else if (!decryptedText || decryptedText === '[Encrypted - Decryption failed]' || decryptedText === '[Media or invalid message]') {
          // Only show these placeholders if decryption actually failed or message is invalid
          formattedLastMessage = decryptedText || '';
        } else {
          formattedLastMessage = decryptedText;
        }
        
        // Add sender name prefix for groups
        if (formattedLastMessage && currentConversation?.type === 'group' && messageData.senderId) {
          // Get sender name from participants or usersStore
          const participant = currentConversation.participants?.find(p => p.id === messageData.senderId);
          const usersStore = useUsersStore.getState();
          const senderUser = usersStore.getCachedById(messageData.senderId);
          
          let senderName: string | undefined;
          
          if (senderUser) {
            if (typeof senderUser.name === 'string') {
              senderName = senderUser.name.split(' ')[0];
            } else if (senderUser.name?.first) {
              senderName = senderUser.name.first;
            } else if (senderUser.username || senderUser.handle) {
              senderName = senderUser.username || senderUser.handle;
            }
          } else if (participant?.name?.first) {
            senderName = participant.name.first;
          } else if (participant?.username) {
            senderName = participant.username;
          } else if (messageData.senderId === currentUserId) {
            senderName = 'You';
          }
          
          if (senderName && formattedLastMessage) {
            formattedLastMessage = `${senderName}: ${formattedLastMessage}`;
          }
        }
        
        updateConversation(messageData.conversationId, {
          lastMessage: formattedLastMessage || '',
          timestamp: new Date(messageData.createdAt).toISOString(),
          // Increment unread count if message is from another user
          // If currentUserId is undefined, treat as unread (from other user)
          unreadCount: !currentUserId || messageData.senderId !== currentUserId
            ? currentUnreadCount + 1
            : currentUnreadCount,
        });
      } catch (error) {
        console.error('[RealtimeMessaging] Error handling new message:', error);
      }
    });

    // Lightweight per-conversation activity ping (sent to every participant's
    // user room). It carries no ciphertext — its job is to keep the conversation
    // list fresh for conversations this device may not receive a `newMessage` for
    // (e.g. a just-linked device with no envelope). We bump recency immediately
    // and reconcile unread badges with the server via a coalesced refresh; unread
    // is never incremented here to avoid double-counting with `newMessage`.
    messagingSocket.on(
      'conversationActivity',
      (data: { conversationId: string; messageId: string; senderId: string; createdAt: string }) => {
        try {
          const currentUserId = getSocketAuth().userId || user?.id;
          if (currentUserId && data.senderId === currentUserId) {
            return;
          }
          const conversation = useConversationsStore.getState().conversationsById[data.conversationId];
          if (conversation && data.createdAt) {
            updateConversation(data.conversationId, {
              timestamp: new Date(data.createdAt).toISOString(),
            });
          }
          scheduleConversationRefresh();
        } catch (error) {
          console.error('[RealtimeMessaging] Error handling conversation activity:', error);
        }
      }
    );

    // Handle message updates (edits)
    messagingSocket.on('messageUpdated', async (messageData: IncomingMessagePayload) => {
      try {
        // Handle plaintext messages (legacy or when encryption unavailable)
        let decryptedText = messageData.text;
        let decryptionSucceeded = false;

        // Get current user ID dynamically
        const currentUserId = getSocketAuth().userId || user?.id;

        // Only decrypt if message is encrypted and not sent by current user
        if (messageData.ciphertext && messageData.senderId && messageData.senderDeviceId) {
          // Skip decryption for messages sent by current user (already plaintext locally)
          if (messageData.senderId !== currentUserId) {
            try {
              decryptedText = await deviceKeysStore.decryptMessageFromSender(
                messageData.ciphertext,
                messageData.senderId,
                messageData.senderDeviceId
              );
              decryptionSucceeded = true;
            } catch (error) {
              console.error('[RealtimeMessaging] Error decrypting updated message:', error);
              decryptedText = '[Encrypted - Decryption failed]';
            }
          }
        }

        const updatedId = messageData._id || messageData.id;
        if (!updatedId) {
          console.warn('[RealtimeMessaging] Dropping messageUpdated with no id');
          return;
        }

        // A successfully-decrypted body may be a versioned attachment payload;
        // decode it so an edited message updates its text / media / location /
        // contact (plain text and own/failed paths pass through verbatim with no
        // synthesized attachments).
        const body: DecryptedBodyFields = decryptionSucceeded
          ? applyDecryptedBody(decryptedText || '')
          : { text: decryptedText || '' };

        updateMessage(messageData.conversationId, updatedId, {
          text: body.text,
          ...(messageData.updatedAt ? { editedAt: new Date(messageData.updatedAt) } : {}),
          ...(body.media ? { media: body.media } : {}),
          ...(body.attachmentType ? { attachmentType: body.attachmentType } : {}),
          ...(body.location ? { location: body.location } : {}),
          ...(body.contact ? { contact: body.contact } : {}),
        });
      } catch (error) {
        console.error('[RealtimeMessaging] Error handling message update:', error);
      }
    });

    // Handle message deletions
    messagingSocket.on('messageDeleted', (data: { conversationId: string; messageId: string }) => {
      try {
        removeMessage(data.conversationId, data.messageId);
      } catch (error) {
        console.error('[RealtimeMessaging] Error handling message deletion:', error);
      }
    });

    // Handle reaction add/remove. The backend emits the full reactions map for the
    // message on both POST (add/toggle) and DELETE (explicit removal), so we always
    // overwrite the local reactions with the authoritative server state. When the
    // last reactor for an emoji is removed the map omits that key entirely, which
    // correctly clears it from the UI.
    messagingSocket.on(
      'messageReactionUpdated',
      (data: { messageId: string; reactions?: Record<string, string[]> }) => {
        try {
          const conversationId = findConversationIdForMessage(data.messageId);
          if (!conversationId) return;
          updateMessage(conversationId, data.messageId, {
            reactions: data.reactions || {},
          });
        } catch (error) {
          console.error('[RealtimeMessaging] Error handling reaction update:', error);
        }
      }
    );

    // Handle typing indicators
    messagingSocket.on('typing', (data: { conversationId: string; userId: string; isTyping: boolean }) => {
      // This will be handled by the typing indicator hook
      // For now, we'll emit a custom event that components can listen to
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('typingIndicator', { detail: data }));
      }
    });

    // Handle read receipts
    messagingSocket.on(
      'messageRead',
      (data: { conversationId: string; userId: string; messageId: string; readAt?: string }) => {
        try {
          const currentUserId = getSocketAuth().userId || user?.id;

          // Our own read from ANOTHER device: clear local unread for this
          // conversation so the badge stays consistent across our devices.
          if (currentUserId && data.userId === currentUserId) {
            useConversationsStore.getState().markAsRead(data.conversationId);
            return;
          }

          // A recipient read OUR message: mark it as read.
          const existingMessages =
            useMessagesStore.getState().messagesByConversation[data.conversationId] || [];
          const message = existingMessages.find((msg) => msg.id === data.messageId);
          if (message && message.senderId === currentUserId && message.isSent) {
            updateMessage(data.conversationId, data.messageId, { readStatus: 'read' });
          }
        } catch (error) {
          console.error('[RealtimeMessaging] Error handling message read:', error);
        }
      }
    );

    // Handle conversation theme updates
    messagingSocket.on('conversationThemeUpdated', (data: { conversationId: string; theme: string }) => {
      try {
        // Update conversation theme in store
        updateConversation(data.conversationId, { theme: data.theme });
      } catch (error) {
        console.error('[RealtimeMessaging] Error handling conversation theme update:', error);
      }
    });

    // This device was revoked server-side. Wipe Signal state and re-register as a
    // brand new device, then drop the (server-disconnected) socket so the connect
    // effect — re-triggered by the new device id — reconnects with the NEW id.
    // The old socket's handshake carries the revoked id and would be rejected.
    messagingSocket.on('device:revoked', (data: { deviceId?: number }) => {
      void (async () => {
        try {
          console.warn('[RealtimeMessaging] device:revoked received for device', data?.deviceId);
          await useDeviceKeysStore.getState().handleRevocation();
        } catch (error) {
          console.error('[RealtimeMessaging] Error handling device revocation:', error);
        } finally {
          // Sever the old connection unconditionally; the connect effect rebuilds
          // a fresh socket using the re-initialized device id.
          disconnectMessagingSocket();
        }
      })();
    });

    // The owner's device list changed (a device was linked or revoked elsewhere).
    // Invalidate the fan-out device-list cache so subsequent sends target the
    // current set, and refresh any mounted linked-devices screen via the store.
    messagingSocket.on('deviceListChanged', (data: { userId?: string }) => {
      try {
        const currentUserId = (messagingSocket?.auth as { userId?: string } | undefined)?.userId || user?.id;
        const target = data?.userId;
        // Only react to our own list changing.
        if (target && currentUserId && target !== currentUserId) return;
        useDeviceKeysStore.getState().invalidateDeviceCache(currentUserId ? [currentUserId] : undefined);
        bumpDeviceListRefresh();
      } catch (error) {
        console.error('[RealtimeMessaging] Error handling device list change:', error);
      }
    });

    // A device's identity (security code) changed. Invalidate the cache so the
    // refreshed identity key is fetched before the next fan-out. The in-chat
    // "security code changed" system row is a later phase; warn for now.
    messagingSocket.on('deviceIdentityChanged', (data: { userId?: string; deviceId?: number }) => {
      try {
        console.warn(
          '[RealtimeMessaging] deviceIdentityChanged for user',
          data?.userId,
          'device',
          data?.deviceId
        );
        if (data?.userId) {
          useDeviceKeysStore.getState().invalidateDeviceCache([data.userId]);
        }
      } catch (error) {
        console.error('[RealtimeMessaging] Error handling device identity change:', error);
      }
    });

    messagingSocket.on('disconnect', () => {
      // Reset flag on disconnect so listeners can be re-setup on reconnect
      if (listenersInitializedSocketId === messagingSocket?.id) {
        listenersInitializedSocketId = null;
      }
    });

    messagingSocket.on('connect_error', (error) => {
      handleMessagingConnectError(error);
    });

    // Mark this socket instance as having listeners set up
    listenersInitializedSocketId = messagingSocket.id;
  }, [user?.id, addMessage, updateMessage, removeMessage, updateConversation, deviceKeysStore]);

  const connectSocket = useCallback(() => {
    if (!isAuthenticated || !user?.id) return;

    // Per-device delivery requires our numeric Signal device id in the socket
    // handshake so the backend can join `device:{userId}:{deviceId}` and route
    // this device's envelope. Gate the connection until device keys are ready —
    // appInitializer sequences this, but reconnects can race ahead.
    const ownDeviceId = useDeviceKeysStore.getState().deviceKeys?.deviceId;
    if (!ownDeviceId) {
      console.warn('[RealtimeMessaging] Device keys not ready; deferring socket connect');
      return;
    }

    // If socket already exists and is connected, just ensure listeners are set up
    if (messagingSocket?.connected) {
      setupEventListeners();
      return;
    }

    // If socket exists but not connected, try to reconnect
    if (messagingSocket && !messagingSocket.connected) {
      messagingSocket.connect();
      setupEventListeners();
      return;
    }

    try {
      // Get the real Oxy access token (verified server-side by oxy.authSocket())
      const token = oxyClient.getAccessToken();
      if (!token) {
        console.warn('[RealtimeMessaging] No access token available yet; skipping socket connect');
        return;
      }

      // Get socket URL - remove /api suffix if present, use HTTP/WS protocol
      let socketUrl = API_URL || process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';
      socketUrl = socketUrl.replace('/api', '').replace('https://', 'wss://').replace('http://', 'ws://');

      messagingSocket = io(`${socketUrl}/messaging`, {
        auth: {
          token,
          userId: user.id,
          deviceId: ownDeviceId,
        },
        transports: ['websocket'], // Only WebSocket, no polling fallback
        path: '/socket.io',
        reconnectionAttempts: 15, // 15 attempts over ~2 minutes before giving up
        reconnectionDelay: 2000, // Start with 2 second delay (less spammy)
        reconnectionDelayMax: 10000, // Max 10 seconds between attempts
        timeout: 10000, // 10 second connection timeout
      });

        messagingSocket.on('connect', () => {
          // Set up listeners once connected
          setupEventListeners();
        });

    } catch (error) {
      console.error('[RealtimeMessaging] Failed to connect to messaging socket:', error);
    }
  }, [isAuthenticated, user?.id, setupEventListeners]);

  const disconnectSocket = useCallback(() => {
    // Tear down the shared module-level socket + globals.
    disconnectMessagingSocket();
    // Clean up this hook instance's own typing timers.
    typingTimeoutRef.current.forEach((timeout) => clearTimeout(timeout));
    typingTimeoutRef.current.clear();
  }, []);

  // Join conversation room when conversationId changes
  useEffect(() => {
    if (messagingSocket?.connected && conversationId) {
      messagingSocket.emit('joinConversation', conversationId);
      return () => {
        if (messagingSocket?.connected) {
          messagingSocket.emit('leaveConversation', conversationId);
        }
      };
    }
  }, [conversationId]);

  // Connect on mount - keep connection alive globally (don't disconnect on unmount)
  // This ensures messages are received even when switching conversations or on conversation list
  // The socket connection is shared across all conversation views (like WhatsApp)
  useEffect(() => {
    // Gate on device keys being ready (connectSocket also guards defensively).
    if (isAuthenticated && user?.id && ownDeviceId) {
      connectSocket();
    }
    // Don't disconnect on unmount - keep connection alive for app lifecycle.
    // Connection is cleaned up on logout/account switch via
    // `disconnectMessagingSocket()` (see `lib/auth/sessionCleanup.ts`).
  }, [isAuthenticated, user?.id, ownDeviceId, connectSocket]);

  // Send typing indicator
  const sendTypingIndicator = useCallback((isTyping: boolean) => {
    if (messagingSocket?.connected && conversationId && user?.id) {
      messagingSocket.emit('typing', {
        conversationId,
        userId: user.id,
        isTyping,
      });
    }
  }, [conversationId, user?.id]);

  return {
    isConnected: messagingSocket?.connected || false,
    sendTypingIndicator,
    socket: messagingSocket,
  };
};

