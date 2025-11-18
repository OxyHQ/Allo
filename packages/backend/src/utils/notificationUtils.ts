// Notification utilities for Allo chat app
// Note: Notification model not yet implemented - this is a placeholder for future use

import { oxy } from '../../server';
import { formatPushForNotification, sendPushToUser } from './push';

export interface CreateNotificationData {
  recipientId: string;
  actorId: string;
  type: 'message' | 'welcome';
  entityId: string;
  entityType: 'message' | 'conversation';
}

/**
 * Creates a notification for a user action
 * Handles duplicate prevention and emits real-time events
 * TODO: Implement Notification model and database storage
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

    // TODO: Store notification in database when Notification model is implemented
    // const notification = new Notification(data);
    // await notification.save();

    // Emit real-time notification if requested with actor profile data
    if (emitEvent && (global as any).io) {
      let actor: any = null;
      try {
        if (data.actorId && data.actorId !== 'system') {
          actor = await oxy.getUserById(data.actorId);
        } else if (data.actorId === 'system') {
          actor = { id: 'system', username: 'system', name: { full: 'System' } };
        }
      } catch (e) {
        // ignore actor resolution failures
      }
      const payload = {
        ...data,
        actorId_populated: actor ? {
          _id: actor.id || actor._id || data.actorId,
          username: actor.username || data.actorId,
          name: actor.name?.full || actor.name || actor.username || data.actorId,
          avatar: actor.avatar
        } : undefined
      };
      const notificationsNamespace = (global as any).io.of('/notifications');
      notificationsNamespace.to(`user:${data.recipientId}`).emit('notification', payload);
    }

    // Fire push notification (best-effort, non-blocking)
    try {
      const push = await formatPushForNotification(data as any);
      await sendPushToUser(data.recipientId, push);
    } catch (e) {
      // ignore push failures
    }

    console.log(`Notification created: ${data.type} from ${data.actorId} to ${data.recipientId}`);
  } catch (error) {
    console.error('Error creating notification:', error);
    // Don't throw error to avoid breaking the main flow
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
