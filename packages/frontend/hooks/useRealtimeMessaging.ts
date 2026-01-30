import { useEffect, useCallback, useRef } from 'react';
import { useOxy } from '@oxyhq/services';
import { io, Socket } from 'socket.io-client';
import { API_URL } from '@/config';
import { useMessagesStore } from '@/stores/messagesStore';
import { useConversationsStore } from '@/stores/conversationsStore';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import { useUsersStore } from '@/stores/usersStore';
import type { Message } from '@/stores/messagesStore';

let messagingSocket: Socket | null = null;
const typingUsers: Map<string, Set<string>> = new Map(); // conversationId -> Set of userIds
let listenersInitializedSocketId: string | null = null; // Track which socket instance has listeners set up

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
    messagingSocket.off('messageUpdated');
    messagingSocket.off('messageDeleted');
    messagingSocket.off('typing');
    messagingSocket.off('messageRead');
    messagingSocket.off('disconnect');
    messagingSocket.off('connect_error');

    // Handle new messages - this listener is set once globally and receives ALL messages
    // Messages come from both conversation rooms and user rooms (backend emits to both)
    messagingSocket.on('newMessage', async (messageData: any) => {
      try {
        // Get current user ID dynamically from socket auth or useOxy store
        // This ensures we always have the correct user ID, even if it changes
        const currentUserId = (messagingSocket?.auth as any)?.userId || user?.id;

        // Skip messages from current user - they're already added locally when sent
        // This prevents duplicates and "[Your message]" text
        if (currentUserId && messageData.senderId === currentUserId) {
          return;
        }

        // Check if message already exists in store (prevent duplicates - O(n) check but necessary)
        const existingMessages = useMessagesStore.getState().messagesByConversation[messageData.conversationId] || [];
        const messageId = messageData._id || messageData.id;
        if (existingMessages.some(msg => msg.id === messageId)) {
          return;
        }

        // Handle plaintext messages (legacy or when encryption unavailable)
        let decryptedText = messageData.text;
        let isEncrypted = false;

        // Only decrypt if message is encrypted
        if (messageData.ciphertext && messageData.senderId && messageData.senderDeviceId) {
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
        } else if (messageData.text) {
          // Plaintext message - always process these, regardless of sender
          decryptedText = messageData.text;
          isEncrypted = false;
          } else {
            // No text and no ciphertext - might be media only or invalid message
            decryptedText = '[Media or invalid message]';
          }

        // Determine read status based on deliveredTo and readBy fields from backend
        let readStatus: 'pending' | 'sent' | 'delivered' | 'read' | undefined = undefined;
        if (currentUserId && messageData.senderId === currentUserId) {
          // This is a message we sent - check delivery status
          // readBy is a Record<string, Date> (userId -> timestamp)
          if (messageData.readBy && typeof messageData.readBy === 'object') {
            const readBy = messageData.readBy as Record<string, Date>;
            const readByUserIds = Object.keys(readBy);
            // If readBy contains recipient IDs (not just sender), message was read
            const recipientRead = readByUserIds.some((id: string) => id !== currentUserId);
            if (recipientRead) {
              readStatus = 'read';
            } else if (messageData.deliveredTo && Array.isArray(messageData.deliveredTo)) {
              const recipientDelivered = messageData.deliveredTo.some((id: string) => id !== currentUserId);
              if (recipientDelivered) {
                readStatus = 'delivered';
              } else {
                readStatus = 'sent';
              }
            } else {
              readStatus = 'sent';
            }
          } else if (messageData.deliveredTo && Array.isArray(messageData.deliveredTo)) {
            // If deliveredTo contains recipient IDs, message was delivered
            const recipientDelivered = messageData.deliveredTo.some((id: string) => id !== currentUserId);
            if (recipientDelivered) {
              readStatus = 'delivered';
            } else {
              readStatus = 'sent';
            }
          } else {
            // Default to sent if no delivery info (message came from server, so it's sent)
            readStatus = 'sent';
          }
        }
        
        const message: Message = {
          id: messageData._id || messageData.id,
          text: decryptedText,
          senderId: messageData.senderId,
          senderDeviceId: messageData.senderDeviceId,
          timestamp: new Date(messageData.createdAt),
          // Mark as sent only if we have a currentUserId AND it matches the sender
          // If currentUserId is undefined, mark as not sent (from other user)
          isSent: !!(currentUserId && messageData.senderId === currentUserId),
          conversationId: messageData.conversationId,
          fontSize: messageData.fontSize,
          isEncrypted: isEncrypted,
          readStatus,
          ...(messageData.ciphertext ? { ciphertext: messageData.ciphertext } : {}),
          messageType: messageData.messageType || 'user',
        };

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
        if (!decryptedText || decryptedText === '[Encrypted - Decryption failed]' || decryptedText === '[Media or invalid message]') {
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

    // Handle message updates (edits)
    messagingSocket.on('messageUpdated', async (messageData: any) => {
      try {
        // Handle plaintext messages (legacy or when encryption unavailable)
        let decryptedText = messageData.text;

        // Get current user ID dynamically
        const currentUserId = (messagingSocket?.auth as any)?.userId || user?.id;
        
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
      try {
        const currentUserId = (messagingSocket?.auth as any)?.userId || user?.id;
        // Update message status to 'read' if this is our message
        const existingMessages = useMessagesStore.getState().messagesByConversation[data.conversationId] || [];
        const message = existingMessages.find(msg => msg.id === data.messageId);
        
        if (message && message.senderId === currentUserId && message.isSent) {
          // This is our message that was read by the recipient
          updateMessage(data.conversationId, data.messageId, { readStatus: 'read' });
        }
      } catch (error) {
        console.error('[RealtimeMessaging] Error handling message read:', error);
      }
    });

    messagingSocket.on('disconnect', () => {
      // Reset flag on disconnect so listeners can be re-setup on reconnect
      if (listenersInitializedSocketId === messagingSocket?.id) {
        listenersInitializedSocketId = null;
      }
    });

    messagingSocket.on('connect_error', (error) => {
      console.error('[RealtimeMessaging] Socket connection error:', error);
    });

    // Mark this socket instance as having listeners set up
    listenersInitializedSocketId = messagingSocket.id;
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

