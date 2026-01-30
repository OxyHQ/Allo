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
  // Read receipt status
  readStatus?: 'pending' | 'sent' | 'delivered' | 'read';
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
    cloudSyncEnabled: true, // Enable cloud sync by default for reliable messaging

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
      
      // Store locally (offline-first) - don't await, do in background
      storeMessagesLocally(conversationId, messages).catch(() => {});
      
      // Update conversation's lastMessage if we have decrypted messages (synchronous, efficient)
      if (messages.length > 0) {
        const lastMessage = messages[messages.length - 1];
        if (lastMessage.text && !lastMessage.isEncrypted && lastMessage.text !== '[Encrypted]') {
          // Use require for synchronous access (faster than async import)
          try {
            const { useConversationsStore } = require('./conversationsStore');
            const { useUsersStore } = require('./usersStore');
            const conversationsStore = useConversationsStore.getState();
            const conversation = conversationsStore.conversationsById[conversationId];
            
            if (conversation) {
              // Format with sender name for groups (O(1) lookup from cache)
              let formattedText = lastMessage.text;
              if (conversation.type === 'group' && lastMessage.senderId) {
                const usersStore = useUsersStore.getState();
                const senderUser = usersStore.getCachedById(lastMessage.senderId);
                const participant = conversation.participants?.find(p => p.id === lastMessage.senderId);
                
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
                }
                
                if (senderName) {
                  formattedText = `${senderName}: ${lastMessage.text}`;
                }
              }
              
              conversationsStore.updateConversation(conversationId, {
                lastMessage: formattedText,
                timestamp: lastMessage.timestamp.toISOString(),
              });
            }
          } catch (error) {
            // Silently fail
          }
        }
      }
    },

    addMessage: async (message) => {
      set((state) => {
        const existing = state.messagesByConversation[message.conversationId] || [];
        
        // Check if message already exists (prevent duplicates)
        const messageExists = existing.some(msg => msg.id === message.id);
        if (messageExists) {
          return state;
        }
        
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
      
      // Store locally - don't await, do in background
      addMessageLocally(message).catch(() => {});
      
      // Update conversation's lastMessage if this is a decrypted message (synchronous, efficient)
      if (message.text && !message.isEncrypted && message.text !== '[Encrypted]') {
        try {
          const { useConversationsStore } = require('./conversationsStore');
          const { useUsersStore } = require('./usersStore');
          const conversationsStore = useConversationsStore.getState();
          const conversation = conversationsStore.conversationsById[message.conversationId];
          
          if (conversation) {
            // Format with sender name for groups (O(1) lookup from cache)
            let formattedText = message.text;
            if (conversation.type === 'group' && message.senderId) {
              const usersStore = useUsersStore.getState();
              const senderUser = usersStore.getCachedById(message.senderId);
              const participant = conversation.participants?.find(p => p.id === message.senderId);
              
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
              }
              
              if (senderName) {
                formattedText = `${senderName}: ${message.text}`;
              }
            }
            
            conversationsStore.updateConversation(message.conversationId, {
              lastMessage: formattedText,
              timestamp: message.timestamp.toISOString(),
            });
          }
        } catch (error) {
          // Silently fail
        }
      }
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

      // TELEGRAM/WHATSAPP PATTERN: Only show loading if no cached messages
      // Otherwise show cached and fetch in background
      const hasCache = (currentState.messagesByConversation[conversationId]?.length || 0) > 0;

      if (!hasCache) {
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
      }

      try {
        // Always load from local storage first (offline-first)
        const localMessages = await getMessagesLocally(conversationId);
        
        if (localMessages.length > 0) {
          // Decrypt messages if needed
          const deviceKeysStore = useDeviceKeysStore.getState();
          const decryptedMessages = await Promise.all(
            localMessages.map(async (msg) => {
              // Skip decryption for messages sent by current user (already plaintext)
              if (msg.senderId === currentUserId) {
                return msg;
              }

              // Only decrypt if message is encrypted and has ciphertext
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
              
              // Process server messages (encrypted or plaintext)
              const deviceKeysStore = useDeviceKeysStore.getState();
              const processedServerMessages = await Promise.all(
                serverMessages.map(async (msg: any) => {
                  // Handle plaintext messages (legacy or when encryption unavailable)
                  if (msg.text && !msg.ciphertext) {
                    // Determine read status for sent messages
                    let readStatus: 'pending' | 'sent' | 'delivered' | 'read' | undefined = undefined;
                    if (msg.senderId === currentUserId) {
                      if (msg.readBy && typeof msg.readBy === 'object') {
                        const readBy = msg.readBy as Record<string, Date>;
                        const readByUserIds = Object.keys(readBy);
                        const recipientRead = readByUserIds.some((id: string) => id !== currentUserId);
                        readStatus = recipientRead ? 'read' : 
                          (msg.deliveredTo && Array.isArray(msg.deliveredTo) && msg.deliveredTo.some((id: string) => id !== currentUserId)) 
                            ? 'delivered' : 'sent';
                      } else if (msg.deliveredTo && Array.isArray(msg.deliveredTo)) {
                        const recipientDelivered = msg.deliveredTo.some((id: string) => id !== currentUserId);
                        readStatus = recipientDelivered ? 'delivered' : 'sent';
                      } else {
                        readStatus = 'sent';
                      }
                    }
                    
                    return {
                      id: msg._id || msg.id,
                      text: msg.text,
                      senderId: msg.senderId,
                      senderDeviceId: msg.senderDeviceId,
                      timestamp: new Date(msg.createdAt),
                      isSent: msg.senderId === currentUserId,
                      conversationId: msg.conversationId,
                      fontSize: msg.fontSize,
                      isEncrypted: false,
                      readStatus,
                      messageType: msg.messageType || 'user',
                    };
                  }

                  // Handle encrypted messages
                  if (msg.ciphertext && msg.senderId && msg.senderDeviceId) {
                    // Skip decryption for messages sent by current user (already plaintext locally)
                    if (msg.senderId === currentUserId) {
                      // This shouldn't happen, but if it does, skip it
                      return null;
                    }

                    try {
                      const decryptedText = await deviceKeysStore.decryptMessageFromSender(
                        msg.ciphertext,
                        msg.senderId,
                        msg.senderDeviceId
                      );
                      // Determine read status for sent messages
                      let readStatus: 'pending' | 'sent' | 'delivered' | 'read' | undefined = undefined;
                      if (msg.senderId === currentUserId) {
                        if (msg.readBy && typeof msg.readBy === 'object') {
                          const readBy = msg.readBy as Record<string, Date>;
                          const readByUserIds = Object.keys(readBy);
                          const recipientRead = readByUserIds.some((id: string) => id !== currentUserId);
                          readStatus = recipientRead ? 'read' : 
                            (msg.deliveredTo && Array.isArray(msg.deliveredTo) && msg.deliveredTo.some((id: string) => id !== currentUserId)) 
                              ? 'delivered' : 'sent';
                        } else if (msg.deliveredTo && Array.isArray(msg.deliveredTo)) {
                          const recipientDelivered = msg.deliveredTo.some((id: string) => id !== currentUserId);
                          readStatus = recipientDelivered ? 'delivered' : 'sent';
                        } else {
                          readStatus = 'sent';
                        }
                      }
                      
                      return {
                        id: msg._id || msg.id,
                        text: decryptedText,
                        senderId: msg.senderId,
                        senderDeviceId: msg.senderDeviceId,
                        timestamp: new Date(msg.createdAt),
                        isSent: msg.senderId === currentUserId,
                        conversationId: msg.conversationId,
                        fontSize: msg.fontSize,
                        isEncrypted: false, // Mark as decrypted
                        readStatus,
                        messageType: msg.messageType || 'user',
                      };
                    } catch (error) {
                      console.error('[Messages] Error decrypting server message:', error);
                      // Return message with error indicator instead of null
                      return {
                        id: msg._id || msg.id,
                        text: '[Encrypted - Decryption failed]',
                        senderId: msg.senderId,
                        senderDeviceId: msg.senderDeviceId,
                        timestamp: new Date(msg.createdAt),
                        isSent: msg.senderId === currentUserId,
                        conversationId: msg.conversationId,
                        fontSize: msg.fontSize,
                        isEncrypted: true, // Still encrypted
                        messageType: msg.messageType || 'user',
                      };
                    }
                  }

                  // Message has neither text nor ciphertext - invalid
                  console.warn('[Messages] Server message missing both text and ciphertext:', msg);
                  return null;
                })
              );
              
              const validMessages = processedServerMessages.filter((msg): msg is Message => msg !== null);
              
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
          // Try to initialize device keys if not already initialized
          if (!deviceKeysStore.isInitialized && !deviceKeysStore.isLoading) {
            try {
              console.log('[Messages] Initializing device keys...');
              await deviceKeysStore.initialize();
              
              // Wait a bit for state to update
              await new Promise(resolve => setTimeout(resolve, 100));
              
              // Re-check device keys after initialization
              const updatedStore = useDeviceKeysStore.getState();
              console.log('[Messages] Device keys after init:', {
                hasKeys: !!updatedStore.deviceKeys,
                isInitialized: updatedStore.isInitialized,
                isLoading: updatedStore.isLoading,
                error: updatedStore.error,
              });
              
              if (!updatedStore.deviceKeys) {
                const errorMsg = updatedStore.error || 'Device keys initialization completed but keys are missing';
                console.error('[Messages] Device keys initialization failed:', errorMsg);
                throw new Error(`Encryption setup failed: ${errorMsg}. Please refresh the page and try again.`);
              }
            } catch (initError) {
              console.error('[Messages] Error initializing device keys:', initError);
              const errorMessage = initError instanceof Error ? initError.message : 'Unknown error';
              throw new Error(`Encryption setup failed: ${errorMessage}. Please refresh the page and try again.`);
            }
          } else if (deviceKeysStore.isLoading) {
            throw new Error('Encryption is initializing. Please wait a moment and try again.');
          } else if (deviceKeysStore.error) {
            throw new Error(`Encryption error: ${deviceKeysStore.error}. Please refresh the page.`);
          } else {
            throw new Error('Encryption not ready. Please wait a moment and try again.');
          }
        }
        
        // Re-get device keys in case they were just initialized
        const finalDeviceKeys = useDeviceKeysStore.getState().deviceKeys;
        if (!finalDeviceKeys) {
          const storeState = useDeviceKeysStore.getState();
          const errorDetails = storeState.error 
            ? ` Error: ${storeState.error}` 
            : ' Please check the console for details.';
          throw new Error(`Encryption not available.${errorDetails}`);
        }

        // Encrypt message (or use plaintext fallback if recipient keys unavailable)
        let ciphertext: string | undefined;
        let isEncrypted = false;
        try {
          const updatedDeviceKeysStore = useDeviceKeysStore.getState();
          ciphertext = await updatedDeviceKeysStore.encryptMessageForRecipient(text, recipientUserId);
          isEncrypted = true;
        } catch (error) {
          console.warn('[Messages] Encryption failed, using plaintext fallback:', error);
          const errorMessage = error instanceof Error ? error.message : 'Unknown encryption error';
          
          // If recipient has no devices registered, allow plaintext as fallback
          if (errorMessage.includes('No devices found') || errorMessage.includes('No preKeys')) {
            console.warn('[Messages] Recipient has no registered devices. Sending as plaintext (less secure).');
            // Continue without encryption - will send as plaintext
            isEncrypted = false;
            ciphertext = undefined;
          } else {
            // For other encryption errors, still throw
            throw new Error('Failed to encrypt message. Please try again.');
          }
        }

        // Create message object with pending status (will update when sent)
        const message: Message = {
          id: `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
          text: text.trim(), // Store plaintext locally for display
          senderId,
          senderDeviceId: finalDeviceKeys.deviceId,
          timestamp: new Date(),
          isSent: true,
          conversationId,
          fontSize,
          isEncrypted: isEncrypted,
          readStatus: 'pending', // Pending while sending
          ...(isEncrypted && ciphertext ? { ciphertext, encryptionVersion: 1 } : {}),
        };

        // Add to local storage immediately (offline-first)
        get().addMessage(message);

        // Try to send via P2P first (if enabled and encrypted)
        // Note: P2P only works with encrypted messages
        const netInfo = await NetInfo.fetch();
        if (netInfo.isConnected && isEncrypted && ciphertext) {
          try {
            const sentViaP2P = await p2pManager.sendMessage(
              conversationId,
              recipientUserId,
              message,
              ciphertext
            );
            
            if (sentViaP2P) {
              // Message sent via P2P - update status to 'sent'
              get().updateMessage(conversationId, message.id, { readStatus: 'sent' });
              return message;
            }
          } catch (error) {
            console.warn('[Messages] P2P send failed, using server:', error);
          }
        }

        // Fallback to server (if cloud sync enabled)
        if (netInfo.isConnected) {
          if (get().cloudSyncEnabled) {
            try {
              // Send encrypted or plaintext based on availability
              const payload: any = {
                conversationId,
                senderDeviceId: finalDeviceKeys.deviceId,
                messageType: 'text',
                fontSize,
              };
              
              if (isEncrypted && ciphertext) {
                payload.ciphertext = ciphertext;
                payload.encryptionVersion = 1;
              } else {
                // Send as plaintext when encryption unavailable
                payload.text = text.trim();
              }
              
              await api.post('/messages', payload);
              
              // Update message status to 'sent' after successful send
              get().updateMessage(conversationId, message.id, { readStatus: 'sent' });
            } catch (error) {
              console.error('[Messages] Error sending to server:', error);
              // Keep as 'pending' if send fails - will retry
              // Add to sync queue for retry
              await addToSyncQueue({
                type: 'send_message',
                conversationId,
                data: {
                  conversationId,
                  senderDeviceId: finalDeviceKeys.deviceId,
                  ...(isEncrypted && ciphertext 
                    ? { ciphertext, encryptionVersion: 1 }
                    : { text: text.trim() }
                  ),
                  messageType: 'text',
                  fontSize,
                },
              });
            }
          }
        }
        
        // If offline or cloud sync disabled, add to sync queue
        if (!netInfo.isConnected || !get().cloudSyncEnabled) {
          // Offline or cloud sync disabled - add to sync queue
          await addToSyncQueue({
            type: 'send_message',
            conversationId,
            data: {
              conversationId,
              senderDeviceId: finalDeviceKeys.deviceId,
              ...(isEncrypted && ciphertext 
                ? { ciphertext, encryptionVersion: 1 }
                : { text: text.trim() }
              ),
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
