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

  const connectSocket = useCallback(() => {
    if (!isAuthenticated || !user?.id || messagingSocket?.connected) return;

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
      });

      // Handle new messages
      messagingSocket.on('newMessage', async (messageData: any) => {
        try {
          // Decrypt message if encrypted
          let decryptedText = messageData.text;
          if (messageData.ciphertext && messageData.senderId && messageData.senderDeviceId) {
            try {
              decryptedText = await deviceKeysStore.decryptMessageFromSender(
                messageData.ciphertext,
                messageData.senderId,
                messageData.senderDeviceId
              );
            } catch (error) {
              console.error('[RealtimeMessaging] Error decrypting message:', error);
              decryptedText = '[Encrypted - Decryption failed]';
            }
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
            isEncrypted: !!messageData.ciphertext,
            ciphertext: messageData.ciphertext,
            messageType: messageData.messageType || 'user',
          };

          addMessage(messageData.conversationId, message);

          // Update conversation last message
          updateConversation(messageData.conversationId, {
            lastMessage: decryptedText || '[Encrypted]',
            timestamp: new Date(messageData.createdAt).toISOString(),
            unreadCount: messageData.senderId !== user.id ? 1 : 0,
          });
        } catch (error) {
          console.error('[RealtimeMessaging] Error handling new message:', error);
        }
      });

      // Handle message updates (edits)
      messagingSocket.on('messageUpdated', async (messageData: any) => {
        try {
          let decryptedText = messageData.text;
          if (messageData.ciphertext && messageData.senderId && messageData.senderDeviceId) {
            try {
              decryptedText = await deviceKeysStore.decryptMessageFromSender(
                messageData.ciphertext,
                messageData.senderId,
                messageData.senderDeviceId
              );
            } catch (error) {
              console.error('[RealtimeMessaging] Error decrypting updated message:', error);
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
      });

      messagingSocket.on('connect_error', (error) => {
        console.error('[RealtimeMessaging] Socket connection error:', error);
      });
    } catch (error) {
      console.error('[RealtimeMessaging] Failed to connect to messaging socket:', error);
    }
  }, [isAuthenticated, user?.id, addMessage, updateMessage, removeMessage, updateConversation, deviceKeysStore]);

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

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    if (isAuthenticated && user?.id) {
      connectSocket();
    } else {
      disconnectSocket();
    }

    return () => {
      disconnectSocket();
    };
  }, [isAuthenticated, user?.id, connectSocket, disconnectSocket]);

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

