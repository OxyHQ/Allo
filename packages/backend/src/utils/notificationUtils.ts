// Notification utilities for Allo chat app

import Notification from '../models/Notification';
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
 *
 * Persists the notification and sends a push via FCM (best-effort). Delivery to
 * the client is FCM only: the legacy realtime `/notifications` Socket.IO
 * namespace was removed (it had no subscribers), so there is no in-app socket
 * fan-out here.
 */
export const createNotification = async (
  data: CreateNotificationData
): Promise<void> => {
  try {
    // Don't create notification if actor and recipient are the same
    if (data.actorId === data.recipientId) {
      return;
    }

    // Persist notification in database
    let savedNotification: any = null;
    try {
      savedNotification = await Notification.create({
        recipientId: data.recipientId,
        senderId: data.actorId,
        type: data.type,
        entityId: data.entityId,
        entityType: data.entityType,
        read: false,
      });
    } catch (dbError) {
      logger.error('Error persisting notification', dbError);
      // Continue: still send the push even if persistence fails
    }

    // Fire push notification (best-effort, non-blocking)
    try {
      const push = await formatPushForNotification({
        ...data,
        _id: savedNotification?._id,
      } as any);
      await sendPushToUser(data.recipientId, push);
    } catch (e) {
      logger.error('Error sending push notification', e);
    }

    logger.info(`Notification created: ${data.type} from ${data.actorId} to ${data.recipientId}`);
  } catch (error) {
    logger.error('Error creating notification', error);
    // Don't throw error to avoid breaking the main flow
  }
};

/**
 * Creates a welcome notification for new users
 */
export const createWelcomeNotification = async (
  userId: string
): Promise<void> => {
  try {
    await createNotification({
      recipientId: userId,
      actorId: 'system', // System-generated notification
      type: 'welcome',
      entityId: userId,
      entityType: 'conversation',
    });
  } catch (error) {
    logger.error('Error creating welcome notification', error);
  }
};

/**
 * Batch create notifications for multiple recipients
 */
export const createBatchNotifications = async (
  notifications: CreateNotificationData[]
): Promise<void> => {
  try {
    const promises = notifications.map(notification =>
      createNotification(notification)
    );
    await Promise.all(promises);
  } catch (error) {
    logger.error('Error creating batch notifications', error);
  }
};
