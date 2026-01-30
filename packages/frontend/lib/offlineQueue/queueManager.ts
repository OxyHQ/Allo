import AsyncStorage from '@react-native-async-storage/async-storage';
import { useConnectionStatusStore } from '@/lib/network/connectionStatus';
import { retryWithBackoff } from '@/lib/api/retryLogic';

/**
 * Offline Queue Manager
 *
 * WhatsApp/Telegram-level: Manages offline operations with automatic retry
 * Provides optimistic updates and seamless online/offline transitions
 */

export interface QueuedOperation {
  id: string;
  type: 'send_message' | 'delete_message' | 'update_message' | 'add_reaction' | 'remove_reaction';
  conversationId: string;
  data: any;
  attempts: number;
  createdAt: number;
  lastAttemptAt?: number;
  status: 'pending' | 'processing' | 'failed';
  error?: string;
}

const QUEUE_STORAGE_KEY = '@allo/offline_queue';
const MAX_QUEUE_SIZE = 1000;
const MAX_ATTEMPTS = 5;

class OfflineQueueManager {
  private queue: QueuedOperation[] = [];
  private isProcessing = false;
  private listeners: Set<(queue: QueuedOperation[]) => void> = new Set();

  constructor() {
    this.loadQueue();
    this.startAutoProcess();
  }

  /**
   * Load queue from storage
   */
  private async loadQueue(): Promise<void> {
    try {
      const stored = await AsyncStorage.getItem(QUEUE_STORAGE_KEY);
      if (stored) {
        this.queue = JSON.parse(stored);
        console.log(`[Queue] Loaded ${this.queue.length} operations from storage`);
        this.notifyListeners();
      }
    } catch (error) {
      console.error('[Queue] Error loading queue:', error);
    }
  }

  /**
   * Save queue to storage
   */
  private async saveQueue(): Promise<void> {
    try {
      // Limit queue size
      if (this.queue.length > MAX_QUEUE_SIZE) {
        console.warn(`[Queue] Queue size exceeds limit, removing oldest ${this.queue.length - MAX_QUEUE_SIZE} operations`);
        this.queue = this.queue.slice(-MAX_QUEUE_SIZE);
      }

      await AsyncStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(this.queue));
      this.notifyListeners();
    } catch (error) {
      console.error('[Queue] Error saving queue:', error);
    }
  }

  /**
   * Add operation to queue
   */
  async add(operation: Omit<QueuedOperation, 'id' | 'attempts' | 'createdAt' | 'status'>): Promise<string> {
    const id = `${operation.type}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    const queuedOp: QueuedOperation = {
      ...operation,
      id,
      attempts: 0,
      createdAt: Date.now(),
      status: 'pending',
    };

    this.queue.push(queuedOp);
    await this.saveQueue();

    console.log(`[Queue] Added operation ${id} (${operation.type}) to queue`);

    // Try to process immediately if online
    this.processQueue();

    return id;
  }

  /**
   * Remove operation from queue
   */
  async remove(id: string): Promise<void> {
    const index = this.queue.findIndex(op => op.id === id);
    if (index !== -1) {
      this.queue.splice(index, 1);
      await this.saveQueue();
      console.log(`[Queue] Removed operation ${id} from queue`);
    }
  }

  /**
   * Get all operations
   */
  getAll(): QueuedOperation[] {
    return [...this.queue];
  }

  /**
   * Get operations by conversation
   */
  getByConversation(conversationId: string): QueuedOperation[] {
    return this.queue.filter(op => op.conversationId === conversationId);
  }

  /**
   * Get operation by ID
   */
  getById(id: string): QueuedOperation | undefined {
    return this.queue.find(op => op.id === id);
  }

  /**
   * Clear entire queue
   */
  async clear(): Promise<void> {
    this.queue = [];
    await this.saveQueue();
    console.log('[Queue] Cleared all operations');
  }

  /**
   * Process queue (try to sync pending operations)
   */
  async processQueue(): Promise<void> {
    const connectionStore = useConnectionStatusStore.getState();

    // Don't process if offline or already processing
    if (!connectionStore.isConnected || this.isProcessing) {
      return;
    }

    // Don't process if queue is empty
    if (this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;
    console.log(`[Queue] Processing ${this.queue.length} operations...`);

    const operationsToProcess = this.queue.filter(
      op => op.status !== 'processing' && op.attempts < MAX_ATTEMPTS
    );

    for (const operation of operationsToProcess) {
      try {
        // Mark as processing
        operation.status = 'processing';
        operation.attempts++;
        operation.lastAttemptAt = Date.now();
        await this.saveQueue();

        // Execute operation with retry
        await this.executeOperation(operation);

        // Success - remove from queue
        await this.remove(operation.id);
        console.log(`[Queue] Successfully processed operation ${operation.id}`);
      } catch (error) {
        console.error(`[Queue] Error processing operation ${operation.id}:`, error);

        // Mark as failed if max attempts reached
        if (operation.attempts >= MAX_ATTEMPTS) {
          operation.status = 'failed';
          operation.error = error instanceof Error ? error.message : 'Unknown error';
          console.error(`[Queue] Operation ${operation.id} failed after ${MAX_ATTEMPTS} attempts`);
        } else {
          operation.status = 'pending';
        }

        await this.saveQueue();
      }
    }

    this.isProcessing = false;
    console.log(`[Queue] Processing complete. ${this.queue.length} operations remaining.`);
  }

  /**
   * Execute a single operation
   */
  private async executeOperation(operation: QueuedOperation): Promise<void> {
    // Import stores dynamically to avoid circular dependencies
    const { api } = await import('@/utils/api');

    switch (operation.type) {
      case 'send_message':
        await retryWithBackoff(() =>
          api.post('/messages', operation.data)
        );
        break;

      case 'delete_message':
        await retryWithBackoff(() =>
          api.delete(`/messages/${operation.data.messageId}`)
        );
        break;

      case 'update_message':
        await retryWithBackoff(() =>
          api.put(`/messages/${operation.data.messageId}`, operation.data.updates)
        );
        break;

      case 'add_reaction':
        await retryWithBackoff(() =>
          api.post(`/messages/${operation.data.messageId}/reactions`, {
            emoji: operation.data.emoji,
          })
        );
        break;

      case 'remove_reaction':
        await retryWithBackoff(() =>
          api.delete(`/messages/${operation.data.messageId}/reactions/${operation.data.emoji}`)
        );
        break;

      default:
        throw new Error(`Unknown operation type: ${(operation as any).type}`);
    }
  }

  /**
   * Start automatic queue processing
   * Processes queue when connection is restored
   */
  private startAutoProcess(): void {
    // Process queue when connection changes to online
    useConnectionStatusStore.subscribe(
      (state) => state.status,
      (status) => {
        if (status === 'online') {
          console.log('[Queue] Connection restored, processing queue...');
          this.processQueue();
        }
      }
    );

    // Also process periodically (every 30 seconds) if online
    setInterval(() => {
      const connectionStore = useConnectionStatusStore.getState();
      if (connectionStore.isConnected && this.queue.length > 0) {
        this.processQueue();
      }
    }, 30000);
  }

  /**
   * Subscribe to queue changes
   */
  subscribe(listener: (queue: QueuedOperation[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notify all listeners of queue changes
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(this.queue));
  }
}

// Singleton instance
export const offlineQueueManager = new OfflineQueueManager();

// Export convenience functions
export const addToQueue = (operation: Omit<QueuedOperation, 'id' | 'attempts' | 'createdAt' | 'status'>) =>
  offlineQueueManager.add(operation);

export const removeFromQueue = (id: string) =>
  offlineQueueManager.remove(id);

export const processQueue = () =>
  offlineQueueManager.processQueue();

export const getQueuedOperations = () =>
  offlineQueueManager.getAll();

export const getQueuedOperationsByConversation = (conversationId: string) =>
  offlineQueueManager.getByConversation(conversationId);
