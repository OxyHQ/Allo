// Notification utilities for Allo chat app
// Note: a persistent Notification model is not yet implemented; notifications
// are currently emitted in real-time and via push only.

import { formatPushForNotification, sendPushToUser } from './push';
import { logger } from './logger';

export interface CreateNotificationData {
  recipientId: string;
  actorId: string;
  type: 'message' | 'welcome';
  entityId: string;
  entityType: 'message' | 'conversation';
}

/**
 * Creates a notification for a user action.
 * Handles duplicate prevention and emits real-time events. Persistent storage
 * via a Notification model is not yet implemented.
 */
export const createNotification = async (
  data: CreateNotificationData,
  emitEvent: boolean = true
): Promise<void> => {
  try {
    // Don't create notification if actor and recipient are the same
    if (data.actorId === data.recipientId) {
      return;
    }

    // Fire push notification (best-effort, non-blocking). `emitEvent` is kept
    // for API compatibility; persistent + real-time delivery land with the
    // Notification model.
    if (emitEvent) {
      try {
        const push = await formatPushForNotification(data);
        await sendPushToUser(data.recipientId, push);
      } catch (e) {
        logger.warn('createNotification: push delivery failed', e);
      }
    }

    logger.info(`Notification created: ${data.type} from ${data.actorId} to ${data.recipientId}`);
  } catch (error) {
    logger.error('Error creating notification', error);
    // Don't throw — notifications must never break the main flow.
  }
};

/**
 * Creates a welcome notification for new users
 */
export const createWelcomeNotification = async (
  userId: string,
  emitEvent: boolean = true
): Promise<void> => {
  try {
    await createNotification({
      recipientId: userId,
      actorId: 'system', // System-generated notification
      type: 'welcome',
      entityId: userId,
      entityType: 'conversation',
    }, emitEvent);
  } catch (error) {
    console.error('Error creating welcome notification:', error);
  }
};

/**
 * Batch create notifications for multiple recipients
 */
export const createBatchNotifications = async (
  notifications: CreateNotificationData[],
  emitEvent: boolean = true
): Promise<void> => {
  try {
    const promises = notifications.map(notification =>
      createNotification(notification, emitEvent)
    );
    await Promise.all(promises);
  } catch (error) {
    console.error('Error creating batch notifications:', error);
  }
};
