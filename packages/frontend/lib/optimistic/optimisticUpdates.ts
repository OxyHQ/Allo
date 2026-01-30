/**
 * Optimistic Updates Helper
 *
 * WhatsApp/Telegram-level: Instant UI updates before server confirmation
 * Provides seamless UX with automatic rollback on failure
 */

export interface OptimisticUpdate<T> {
  id: string;
  type: string;
  data: T;
  createdAt: number;
  status: 'pending' | 'confirmed' | 'failed';
  rollback?: () => void;
}

/**
 * Optimistic Update Manager
 * Tracks pending optimistic updates and handles rollback
 */
export class OptimisticUpdateManager<T = any> {
  private updates = new Map<string, OptimisticUpdate<T>>();
  private listeners = new Set<(updates: Map<string, OptimisticUpdate<T>>) => void>();

  /**
   * Add optimistic update
   *
   * @example
   * const updateId = manager.add({
   *   id: 'msg-123',
   *   type: 'send_message',
   *   data: message,
   *   rollback: () => removeMessage(message.id),
   * });
   */
  add(update: Omit<OptimisticUpdate<T>, 'createdAt' | 'status'>): string {
    const fullUpdate: OptimisticUpdate<T> = {
      ...update,
      createdAt: Date.now(),
      status: 'pending',
    };

    this.updates.set(update.id, fullUpdate);
    this.notifyListeners();

    console.log(`[Optimistic] Added update ${update.id} (${update.type})`);

    return update.id;
  }

  /**
   * Confirm optimistic update (server succeeded)
   */
  confirm(id: string): void {
    const update = this.updates.get(id);
    if (update) {
      update.status = 'confirmed';
      // Remove confirmed updates after a delay
      setTimeout(() => {
        this.updates.delete(id);
        this.notifyListeners();
      }, 1000);

      console.log(`[Optimistic] Confirmed update ${id}`);
      this.notifyListeners();
    }
  }

  /**
   * Fail optimistic update (server failed, rollback)
   */
  fail(id: string, rollback: boolean = true): void {
    const update = this.updates.get(id);
    if (update) {
      update.status = 'failed';

      if (rollback && update.rollback) {
        console.log(`[Optimistic] Rolling back update ${id}`);
        update.rollback();
      }

      // Remove failed updates after a delay
      setTimeout(() => {
        this.updates.delete(id);
        this.notifyListeners();
      }, 2000);

      console.log(`[Optimistic] Failed update ${id}`);
      this.notifyListeners();
    }
  }

  /**
   * Get update by ID
   */
  get(id: string): OptimisticUpdate<T> | undefined {
    return this.updates.get(id);
  }

  /**
   * Get all pending updates
   */
  getPending(): OptimisticUpdate<T>[] {
    return Array.from(this.updates.values()).filter(u => u.status === 'pending');
  }

  /**
   * Get all updates of a specific type
   */
  getByType(type: string): OptimisticUpdate<T>[] {
    return Array.from(this.updates.values()).filter(u => u.type === type);
  }

  /**
   * Check if update is pending
   */
  isPending(id: string): boolean {
    const update = this.updates.get(id);
    return update?.status === 'pending' ?? false;
  }

  /**
   * Clear all updates
   */
  clear(): void {
    this.updates.clear();
    this.notifyListeners();
  }

  /**
   * Subscribe to updates
   */
  subscribe(listener: (updates: Map<string, OptimisticUpdate<T>>) => void): () => void {
    this.listeners.add(listener);
    listener(this.updates); // Call immediately with current state
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notify all listeners
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => listener(new Map(this.updates)));
  }
}

/**
 * Execute function with optimistic update
 * Automatically confirms on success, rolls back on failure
 *
 * @example
 * await withOptimisticUpdate(
 *   manager,
 *   {
 *     id: 'msg-123',
 *     type: 'send_message',
 *     data: message,
 *     rollback: () => removeMessage(message.id),
 *   },
 *   () => api.post('/messages', message)
 * );
 */
export async function withOptimisticUpdate<T, R>(
  manager: OptimisticUpdateManager<T>,
  update: Omit<OptimisticUpdate<T>, 'createdAt' | 'status'>,
  fn: () => Promise<R>
): Promise<R> {
  const updateId = manager.add(update);

  try {
    const result = await fn();
    manager.confirm(updateId);
    return result;
  } catch (error) {
    manager.fail(updateId, true);
    throw error;
  }
}

/**
 * Batch optimistic updates
 * Executes multiple operations with optimistic updates
 *
 * @example
 * await batchOptimisticUpdates(manager, [
 *   {
 *     update: { id: '1', type: 'delete', data: msg1, rollback: () => addMessage(msg1) },
 *     fn: () => api.delete('/messages/1'),
 *   },
 *   {
 *     update: { id: '2', type: 'delete', data: msg2, rollback: () => addMessage(msg2) },
 *     fn: () => api.delete('/messages/2'),
 *   },
 * ]);
 */
export async function batchOptimisticUpdates<T>(
  manager: OptimisticUpdateManager<T>,
  operations: Array<{
    update: Omit<OptimisticUpdate<T>, 'createdAt' | 'status'>;
    fn: () => Promise<any>;
  }>
): Promise<void> {
  const updateIds = operations.map(op => manager.add(op.update));

  try {
    await Promise.all(operations.map(op => op.fn()));
    updateIds.forEach(id => manager.confirm(id));
  } catch (error) {
    updateIds.forEach(id => manager.fail(id, true));
    throw error;
  }
}

// Global managers for common operations
export const messageOptimisticManager = new OptimisticUpdateManager();
export const conversationOptimisticManager = new OptimisticUpdateManager();
export const reactionOptimisticManager = new OptimisticUpdateManager();
