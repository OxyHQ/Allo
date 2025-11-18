import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { api } from '@/utils/api';
import { useDeviceKeysStore } from './deviceKeysStore';
import {
  storeMessagesLocally,
  getMessagesLocally,
  addMessageLocally,
  updateMessageLocally,
  removeMessageLocally,
  addToSyncQueue,
} from '@/lib/offlineStorage';
import { p2pManager } from '@/lib/p2pMessaging';
import NetInfo from '@react-native-community/netinfo';

/**
 * Messages Store with Signal Protocol Encryption
 * 
 * Features:
 * - End-to-end encryption using Signal Protocol
 * - Offline-first storage (device-first)
 * - Optional cloud sync
 * - P2P messaging when available
 */

export interface MediaItem {
  id: string;
  type: 'image' | 'video' | 'gif';
  url?: string;
}

export interface Message {
  id: string;
  text: string;
  senderId: string;
  senderDeviceId?: number;
  senderName?: string;
  timestamp: Date;
  isSent: boolean;
  conversationId: string;
  messageType?: 'user' | 'ai';
  media?: MediaItem[];
  fontSize?: number;
  replyTo?: string; // Message ID this is replying to
  reactions?: Record<string, string[]>; // emoji -> array of userIds
  // Encryption metadata
  isEncrypted?: boolean;
  ciphertext?: string;
  encryptionVersion?: number;
}

interface MessagesState {
  // Data: messages organized by conversation ID
  messagesByConversation: Record<string, Message[]>;
  
  // Loading states by conversation
  loadingByConversation: Record<string, boolean>;
  errorByConversation: Record<string, string | null>;
  
  // Last updated timestamps by conversation
  lastUpdatedByConversation: Record<string, number>;
  
  // Cloud sync enabled
  cloudSyncEnabled: boolean;
  
  // Actions
  setMessages: (conversationId: string, messages: Message[]) => void;
  addMessage: (message: Message) => void;
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void;
  removeMessage: (conversationId: string, messageId: string) => void;
  clearMessages: (conversationId: string) => void;
  setCloudSyncEnabled: (enabled: boolean) => void;
  addReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  removeReaction: (conversationId: string, messageId: string, emoji: string) => Promise<void>;
  
  // Async actions
  fetchMessages: (conversationId: string, currentUserId?: string) => Promise<void>;
  sendMessage: (
    conversationId: string,
    text: string,
    senderId: string,
    recipientUserId: string,
    fontSize?: number
  ) => Promise<Message | null>;
  
  // Selectors
  getMessages: (conversationId: string) => Message[];
  getLatestMessage: (conversationId: string) => Message | undefined;
  isLoading: (conversationId: string) => boolean;
  getError: (conversationId: string) => string | null;
}

export const useMessagesStore = create<MessagesState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    messagesByConversation: {},
    loadingByConversation: {},
    errorByConversation: {},
    lastUpdatedByConversation: {},
    cloudSyncEnabled: false, // Device-first by default

    // Actions
    setMessages: async (conversationId, messages) => {
      set((state) => ({
        messagesByConversation: {
          ...state.messagesByConversation,
          [conversationId]: messages,
        },
        lastUpdatedByConversation: {
          ...state.lastUpdatedByConversation,
          [conversationId]: Date.now(),
        },
        errorByConversation: {
          ...state.errorByConversation,
          [conversationId]: null,
        },
      }));
      
      // Store locally (offline-first)
      await storeMessagesLocally(conversationId, messages);
    },

    addMessage: async (message) => {
      set((state) => {
        const existing = state.messagesByConversation[message.conversationId] || [];
        const updated = [...existing, message];
        return {
          messagesByConversation: {
            ...state.messagesByConversation,
            [message.conversationId]: updated,
          },
          lastUpdatedByConversation: {
            ...state.lastUpdatedByConversation,
            [message.conversationId]: Date.now(),
          },
        };
      });
      
      // Store locally
      await addMessageLocally(message);
    },

    updateMessage: async (conversationId, messageId, updates) => {
      set((state) => {
        const messages = state.messagesByConversation[conversationId] || [];
        const updated = messages.map(msg =>
          msg.id === messageId ? { ...msg, ...updates } : msg
        );
        return {
          messagesByConversation: {
            ...state.messagesByConversation,
            [conversationId]: updated,
          },
          lastUpdatedByConversation: {
            ...state.lastUpdatedByConversation,
            [conversationId]: Date.now(),
          },
        };
      });
      
      // Update locally
      await updateMessageLocally(conversationId, messageId, updates);
    },

    removeMessage: async (conversationId, messageId) => {
      set((state) => {
        const messages = state.messagesByConversation[conversationId] || [];
        const filtered = messages.filter(msg => msg.id !== messageId);
        return {
          messagesByConversation: {
            ...state.messagesByConversation,
            [conversationId]: filtered,
          },
          lastUpdatedByConversation: {
            ...state.lastUpdatedByConversation,
            [conversationId]: Date.now(),
          },
        };
      });
      
      // Remove locally
      await removeMessageLocally(conversationId, messageId);
    },

    clearMessages: (conversationId) => {
      set((state) => {
        const { [conversationId]: removed, ...messagesByConversation } = state.messagesByConversation;
        const { [conversationId]: removedLoading, ...loadingByConversation } = state.loadingByConversation;
        const { [conversationId]: removedError, ...errorByConversation } = state.errorByConversation;
        const { [conversationId]: removedUpdated, ...lastUpdatedByConversation } = state.lastUpdatedByConversation;
        
        return {
          messagesByConversation,
          loadingByConversation,
          errorByConversation,
          lastUpdatedByConversation,
        };
      });
    },

    setCloudSyncEnabled: (enabled) => {
      set({ cloudSyncEnabled: enabled });
    },

    // Async actions
    fetchMessages: async (conversationId, currentUserId?) => {
      const currentState = get();
      if (currentState.loadingByConversation[conversationId]) {
        return;
      }

      set((state) => ({
        loadingByConversation: {
          ...state.loadingByConversation,
          [conversationId]: true,
        },
        errorByConversation: {
          ...state.errorByConversation,
          [conversationId]: null,
        },
      }));

      try {
        // Always load from local storage first (offline-first)
        const localMessages = await getMessagesLocally(conversationId);
        
        if (localMessages.length > 0) {
          // Decrypt messages if needed
          const deviceKeysStore = useDeviceKeysStore.getState();
          const decryptedMessages = await Promise.all(
            localMessages.map(async (msg) => {
              if (msg.isEncrypted && msg.ciphertext && msg.senderId && msg.senderDeviceId) {
                try {
                  const decryptedText = await deviceKeysStore.decryptMessageFromSender(
                    msg.ciphertext,
                    msg.senderId,
                    msg.senderDeviceId
                  );
                  return { ...msg, text: decryptedText, isEncrypted: false };
                } catch (error) {
                  console.error('[Messages] Error decrypting message:', error);
                  return { ...msg, text: '[Encrypted - Decryption failed]' };
                }
              }
              return msg;
            })
          );
          
          get().setMessages(conversationId, decryptedMessages);
        }

        // If cloud sync is enabled, fetch from server
        if (get().cloudSyncEnabled) {
          try {
            const netInfo = await NetInfo.fetch();
            if (netInfo.isConnected) {
              const response = await api.get('/messages', { conversationId });
              const serverMessages = response.data.messages || [];
              
              // Decrypt server messages
              const deviceKeysStore = useDeviceKeysStore.getState();
              const decryptedServerMessages = await Promise.all(
                serverMessages.map(async (msg: any) => {
                  if (msg.ciphertext && msg.senderId && msg.senderDeviceId) {
                    try {
                      const decryptedText = await deviceKeysStore.decryptMessageFromSender(
                        msg.ciphertext,
                        msg.senderId,
                        msg.senderDeviceId
                      );
                      return {
                        id: msg._id || msg.id,
                        text: decryptedText,
                        senderId: msg.senderId,
                        senderDeviceId: msg.senderDeviceId,
                        timestamp: new Date(msg.createdAt),
                        isSent: msg.senderId === currentUserId,
                        conversationId: msg.conversationId,
                        fontSize: msg.fontSize,
                        isEncrypted: false,
                        messageType: msg.messageType || 'user',
                      };
                    } catch (error) {
                      console.error('[Messages] Error decrypting server message:', error);
                      return null;
                    }
                  }
                  return null;
                })
              );
              
              const validMessages = decryptedServerMessages.filter((msg): msg is Message => msg !== null);
              
              // Merge with local messages
              const allMessages = [...localMessages, ...validMessages];
              const uniqueMessages = Array.from(
                new Map(allMessages.map(msg => [msg.id, msg])).values()
              ).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
              
              get().setMessages(conversationId, uniqueMessages);
            }
          } catch (error) {
            console.warn('[Messages] Error fetching from server (using local):', error);
          }
        }

        set((state) => ({
          loadingByConversation: {
            ...state.loadingByConversation,
            [conversationId]: false,
          },
        }));
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to fetch messages';
        set((state) => ({
          loadingByConversation: {
            ...state.loadingByConversation,
            [conversationId]: false,
          },
          errorByConversation: {
            ...state.errorByConversation,
            [conversationId]: errorMessage,
          },
        }));
      }
    },

    sendMessage: async (conversationId, text, senderId, recipientUserId, fontSize) => {
      try {
        const deviceKeysStore = useDeviceKeysStore.getState();
        const deviceKeys = deviceKeysStore.deviceKeys;
        
        if (!deviceKeys) {
          throw new Error('Device keys not initialized');
        }

        // Encrypt message
        let ciphertext: string;
        try {
          ciphertext = await deviceKeysStore.encryptMessageForRecipient(text, recipientUserId);
        } catch (error) {
          console.error('[Messages] Error encrypting message:', error);
          throw new Error('Failed to encrypt message');
        }

        // Create message object
        const message: Message = {
          id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          text: text.trim(), // Store plaintext locally for display
          senderId,
          senderDeviceId: deviceKeys.deviceId,
          timestamp: new Date(),
          isSent: true,
          conversationId,
          fontSize,
          isEncrypted: true,
          ciphertext,
          encryptionVersion: 1,
        };

        // Add to local storage immediately (offline-first)
        get().addMessage(message);

        // Try to send via P2P first (if enabled)
        const netInfo = await NetInfo.fetch();
        if (netInfo.isConnected) {
          try {
            const sentViaP2P = await p2pManager.sendMessage(
              conversationId,
              recipientUserId,
              message,
              ciphertext
            );
            
            if (sentViaP2P) {
              // Message sent via P2P
              return message;
            }
          } catch (error) {
            console.warn('[Messages] P2P send failed, using server:', error);
          }

          // Fallback to server (if cloud sync enabled)
          if (get().cloudSyncEnabled) {
            try {
              await api.post('/messages', {
                conversationId,
                senderDeviceId: deviceKeys.deviceId,
                ciphertext,
                encryptionVersion: 1,
                messageType: 'text',
                fontSize,
              });
            } catch (error) {
              console.error('[Messages] Error sending to server:', error);
              // Add to sync queue for retry
              await addToSyncQueue({
                type: 'send_message',
                conversationId,
                data: {
                  conversationId,
                  senderDeviceId: deviceKeys.deviceId,
                  ciphertext,
                  encryptionVersion: 1,
                  messageType: 'text',
                  fontSize,
                },
              });
            }
          }
        } else {
          // Offline - add to sync queue
          await addToSyncQueue({
            type: 'send_message',
            conversationId,
            data: {
              conversationId,
              senderDeviceId: deviceKeys.deviceId,
              ciphertext,
              encryptionVersion: 1,
              messageType: 'text',
              fontSize,
            },
          });
        }

        return message;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to send message';
        set((state) => ({
          errorByConversation: {
            ...state.errorByConversation,
            [conversationId]: errorMessage,
          },
        }));
        return null;
      }
    },

    // Selectors
    getMessages: (conversationId) => {
      return get().messagesByConversation[conversationId] || [];
    },

    getLatestMessage: (conversationId) => {
      const messages = get().getMessages(conversationId);
      return messages.length > 0 ? messages[messages.length - 1] : undefined;
    },

    isLoading: (conversationId) => {
      return get().loadingByConversation[conversationId] || false;
    },

    getError: (conversationId) => {
      return get().errorByConversation[conversationId] || null;
    },
  }))
);
