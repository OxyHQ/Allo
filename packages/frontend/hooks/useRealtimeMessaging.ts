import { useEffect, useCallback, useRef } from 'react';
import { useOxy } from '@oxyhq/services';
import { io, Socket } from 'socket.io-client';
import { API_URL } from '@/config';
import { useMessagesStore } from '@/stores/messagesStore';
import { useConversationsStore } from '@/stores/conversationsStore';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import type { Message } from '@/stores/messagesStore';

let messagingSocket: Socket | null = null;
const typingUsers: Map<string, Set<string>> = new Map(); // conversationId -> Set of userIds
let listenersInitialized = false; // Track if event listeners are set up

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
  const typingTimeoutRef = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Set up event listeners (only once, even if socket reconnects)
  const setupEventListeners = useCallback(() => {
    if (!messagingSocket || listenersInitialized) return;

    console.log('[RealtimeMessaging] Setting up event listeners');

    // Handle new messages - this listener is set once globally and receives ALL messages
    // Messages come from both conversation rooms and user rooms (backend emits to both)
    messagingSocket.on('newMessage', async (messageData: any) => {
      try {
        console.log('[RealtimeMessaging] Received newMessage event:', {
          conversationId: messageData.conversationId,
          senderId: messageData.senderId,
          hasText: !!messageData.text,
          hasCiphertext: !!messageData.ciphertext,
        });

        // Handle plaintext messages (legacy or when encryption unavailable)
        let decryptedText = messageData.text;
        let isEncrypted = false;

        // Only decrypt if message is encrypted and not sent by current user
        if (messageData.ciphertext && messageData.senderId && messageData.senderDeviceId) {
          // Skip decryption for messages sent by current user (already plaintext locally)
          if (messageData.senderId === user.id) {
            // Use plaintext if available, otherwise skip
            decryptedText = messageData.text || '[Your message]';
            isEncrypted = false;
          } else {
            // Decrypt message from other users
            isEncrypted = true;
            try {
              decryptedText = await deviceKeysStore.decryptMessageFromSender(
                messageData.ciphertext,
                messageData.senderId,
                messageData.senderDeviceId
              );
              isEncrypted = false; // Successfully decrypted
            } catch (error) {
              console.error('[RealtimeMessaging] Error decrypting message:', error);
              decryptedText = '[Encrypted - Decryption failed]';
              isEncrypted = true; // Still encrypted
            }
          }
        } else if (messageData.text) {
          // Plaintext message
          decryptedText = messageData.text;
          isEncrypted = false;
        }

        const message: Message = {
          id: messageData._id || messageData.id,
          text: decryptedText,
          senderId: messageData.senderId,
          senderDeviceId: messageData.senderDeviceId,
          timestamp: new Date(messageData.createdAt),
          isSent: messageData.senderId === user.id,
          conversationId: messageData.conversationId,
          fontSize: messageData.fontSize,
          isEncrypted: isEncrypted,
          ...(messageData.ciphertext ? { ciphertext: messageData.ciphertext } : {}),
          messageType: messageData.messageType || 'user',
        };

        console.log('[RealtimeMessaging] Adding message to store:', {
          conversationId: message.conversationId,
          messageId: message.id,
          text: decryptedText?.substring(0, 50),
        });

        // Add message to store - this updates the conversation list immediately
        addMessage(messageData.conversationId, message);

        // Update conversation last message and unread count
        // This ensures the conversation list shows the latest message instantly
        const currentConversation = useConversationsStore.getState().conversationsById[messageData.conversationId];
        const currentUnreadCount = currentConversation?.unreadCount || 0;
        
        updateConversation(messageData.conversationId, {
          lastMessage: decryptedText || '[Encrypted]',
          timestamp: new Date(messageData.createdAt).toISOString(),
          // Increment unread count if message is from another user
          unreadCount: messageData.senderId !== user.id 
            ? currentUnreadCount + 1 
            : currentUnreadCount,
        });

        console.log('[RealtimeMessaging] Message processed successfully');
      } catch (error) {
        console.error('[RealtimeMessaging] Error handling new message:', error);
      }
    });

    // Handle message updates (edits)
    messagingSocket.on('messageUpdated', async (messageData: any) => {
      try {
        // Handle plaintext messages (legacy or when encryption unavailable)
        let decryptedText = messageData.text;

        // Only decrypt if message is encrypted and not sent by current user
        if (messageData.ciphertext && messageData.senderId && messageData.senderDeviceId) {
          // Skip decryption for messages sent by current user (already plaintext locally)
          if (messageData.senderId !== user.id) {
            try {
              decryptedText = await deviceKeysStore.decryptMessageFromSender(
                messageData.ciphertext,
                messageData.senderId,
                messageData.senderDeviceId
              );
            } catch (error) {
              console.error('[RealtimeMessaging] Error decrypting updated message:', error);
              decryptedText = '[Encrypted - Decryption failed]';
            }
          }
        }

        updateMessage(messageData.conversationId, messageData._id || messageData.id, {
          text: decryptedText,
          editedAt: new Date(messageData.updatedAt),
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

    // Handle typing indicators
    messagingSocket.on('typing', (data: { conversationId: string; userId: string; isTyping: boolean }) => {
      // This will be handled by the typing indicator hook
      // For now, we'll emit a custom event that components can listen to
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('typingIndicator', { detail: data }));
      }
    });

    // Handle read receipts
    messagingSocket.on('messageRead', (data: { conversationId: string; userId: string; messageId: string }) => {
      // Update message read status
      // This would need to be added to the Message type
    });

    messagingSocket.on('disconnect', () => {
      console.log('[RealtimeMessaging] Disconnected from messaging socket');
      // Reset flag on disconnect so listeners can be re-setup on reconnect
      listenersInitialized = false;
    });

    messagingSocket.on('connect_error', (error) => {
      console.error('[RealtimeMessaging] Socket connection error:', error);
    });

    listenersInitialized = true;
  }, [user?.id, addMessage, updateMessage, removeMessage, updateConversation, deviceKeysStore]);

  const connectSocket = useCallback(() => {
    if (!isAuthenticated || !user?.id) return;

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
      // Get token from Oxy services - this will be handled by the authenticated client
      // For now, we'll get it from the auth header if available
      const token = user?.id ? 'token' : null; // TODO: Get actual token from Oxy
      
      // Get socket URL - remove /api suffix if present, use HTTP/WS protocol
      let socketUrl = API_URL || process.env.EXPO_PUBLIC_API_URL || 'http://localhost:3000';
      socketUrl = socketUrl.replace('/api', '').replace('https://', 'wss://').replace('http://', 'ws://');
      
      messagingSocket = io(`${socketUrl}/messaging`, {
        auth: {
          token,
          userId: user.id,
        },
        transports: ['websocket', 'polling'],
        path: '/socket.io',
      });

      messagingSocket.on('connect', () => {
        console.log('[RealtimeMessaging] Connected to messaging socket');
        // Set up listeners once connected
        setupEventListeners();
      });

    } catch (error) {
      console.error('[RealtimeMessaging] Failed to connect to messaging socket:', error);
    }
  }, [isAuthenticated, user?.id, setupEventListeners]);

  const disconnectSocket = useCallback(() => {
    if (messagingSocket) {
      messagingSocket.disconnect();
      messagingSocket = null;
    }
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
    if (isAuthenticated && user?.id) {
      connectSocket();
    }
    // Don't disconnect on unmount - keep connection alive for app lifecycle
    // Connection will be cleaned up when user logs out (handled elsewhere)
  }, [isAuthenticated, user?.id, connectSocket]);

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

