/**
 * Offline Storage for Messages
 * 
 * Device-first storage using AsyncStorage for offline message persistence
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { Message } from '@/stores/messagesStore';

const MESSAGES_PREFIX = 'messages_';
const CONVERSATIONS_PREFIX = 'conversations_';
const CONVERSATIONS_LIST_KEY = 'conversations_list';
const SYNC_QUEUE_KEY = 'sync_queue';

export interface SyncQueueItem {
  id: string;
  type: 'send_message' | 'update_message' | 'delete_message';
  conversationId: string;
  data: any;
  timestamp: number;
  retries: number;
}

/**
 * Store conversations list locally (offline-first like WhatsApp/Telegram)
 * Called after every successful API fetch to keep cache fresh
 */
export async function storeConversationsLocally(conversations: any[]): Promise<void> {
  try {
    await AsyncStorage.setItem(CONVERSATIONS_LIST_KEY, JSON.stringify(conversations));
  } catch (error) {
    console.error('[OfflineStorage] Error storing conversations:', error);
  }
}

/**
 * Get cached conversations list from local storage
 * Returns instantly on cold start before API responds
 */
export async function getConversationsLocally(): Promise<any[]> {
  try {
    const data = await AsyncStorage.getItem(CONVERSATIONS_LIST_KEY);
    if (!data) return [];
    return JSON.parse(data);
  } catch (error) {
    console.error('[OfflineStorage] Error getting conversations:', error);
    return [];
  }
}

/**
 * Store messages locally for a conversation
 */
export async function storeMessagesLocally(
  conversationId: string,
  messages: Message[]
): Promise<void> {
  try {
    const key = `${MESSAGES_PREFIX}${conversationId}`;
    await AsyncStorage.setItem(key, JSON.stringify(messages));
  } catch (error) {
    console.error('[OfflineStorage] Error storing messages:', error);
  }
}

/**
 * Get messages from local storage
 */
export async function getMessagesLocally(conversationId: string): Promise<Message[]> {
  try {
    const key = `${MESSAGES_PREFIX}${conversationId}`;
    const data = await AsyncStorage.getItem(key);
    if (!data) return [];
    
    const messages = JSON.parse(data);
    // Convert timestamp strings back to Date objects
    return messages.map((msg: any) => ({
      ...msg,
      timestamp: new Date(msg.timestamp),
    }));
  } catch (error) {
    console.error('[OfflineStorage] Error getting messages:', error);
    return [];
  }
}

/**
 * Add a message to local storage
 */
export async function addMessageLocally(message: Message): Promise<void> {
  try {
    const messages = await getMessagesLocally(message.conversationId);
    messages.push(message);
    await storeMessagesLocally(message.conversationId, messages);
  } catch (error) {
    console.error('[OfflineStorage] Error adding message:', error);
  }
}

/**
 * Update a message in local storage
 */
export async function updateMessageLocally(
  conversationId: string,
  messageId: string,
  updates: Partial<Message>
): Promise<void> {
  try {
    const messages = await getMessagesLocally(conversationId);
    const index = messages.findIndex(msg => msg.id === messageId);
    if (index !== -1) {
      messages[index] = { ...messages[index], ...updates };
      await storeMessagesLocally(conversationId, messages);
    }
  } catch (error) {
    console.error('[OfflineStorage] Error updating message:', error);
  }
}

/**
 * Remove a message from local storage
 */
export async function removeMessageLocally(
  conversationId: string,
  messageId: string
): Promise<void> {
  try {
    const messages = await getMessagesLocally(conversationId);
    const filtered = messages.filter(msg => msg.id !== messageId);
    await storeMessagesLocally(conversationId, filtered);
  } catch (error) {
    console.error('[OfflineStorage] Error removing message:', error);
  }
}

/**
 * Clear messages for a conversation
 */
export async function clearMessagesLocally(conversationId: string): Promise<void> {
  try {
    const key = `${MESSAGES_PREFIX}${conversationId}`;
    await AsyncStorage.removeItem(key);
  } catch (error) {
    console.error('[OfflineStorage] Error clearing messages:', error);
  }
}

/**
 * Add item to sync queue (for offline operations)
 */
export async function addToSyncQueue(item: Omit<SyncQueueItem, 'id' | 'timestamp' | 'retries'>): Promise<void> {
  try {
    const queue = await getSyncQueue();
    const newItem: SyncQueueItem = {
      id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      ...item,
      timestamp: Date.now(),
      retries: 0,
    };
    queue.push(newItem);
    await AsyncStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
  } catch (error) {
    console.error('[OfflineStorage] Error adding to sync queue:', error);
  }
}

/**
 * Get sync queue
 */
export async function getSyncQueue(): Promise<SyncQueueItem[]> {
  try {
    const data = await AsyncStorage.getItem(SYNC_QUEUE_KEY);
    if (!data) return [];
    return JSON.parse(data);
  } catch (error) {
    console.error('[OfflineStorage] Error getting sync queue:', error);
    return [];
  }
}

/**
 * Remove item from sync queue
 */
export async function removeFromSyncQueue(itemId: string): Promise<void> {
  try {
    const queue = await getSyncQueue();
    const filtered = queue.filter(item => item.id !== itemId);
    await AsyncStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(filtered));
  } catch (error) {
    console.error('[OfflineStorage] Error removing from sync queue:', error);
  }
}

/**
 * Increment retry count for sync queue item
 */
export async function incrementSyncQueueRetry(itemId: string): Promise<void> {
  try {
    const queue = await getSyncQueue();
    const item = queue.find(i => i.id === itemId);
    if (item) {
      item.retries += 1;
      await AsyncStorage.setItem(SYNC_QUEUE_KEY, JSON.stringify(queue));
    }
  } catch (error) {
    console.error('[OfflineStorage] Error incrementing retry:', error);
  }
}

/**
 * Clear sync queue
 */
export async function clearSyncQueue(): Promise<void> {
  try {
    await AsyncStorage.removeItem(SYNC_QUEUE_KEY);
  } catch (error) {
    console.error('[OfflineStorage] Error clearing sync queue:', error);
  }
}

