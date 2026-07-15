import { useEffect, useCallback, useRef } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { io, Socket } from 'socket.io-client';
import { API_URL_SOCKET } from '../config';
import { ZRawNotification } from '../types/validation';
import { logger } from '@/utils/logger';

let socket: Socket | null = null;
let invalidationTimer: NodeJS.Timeout | null = null;

// Batch invalidations to prevent 4x queries on rapid socket events
const batchedInvalidateNotifications = (queryClient: QueryClient) => {
  if (invalidationTimer) {
    clearTimeout(invalidationTimer);
  }

  invalidationTimer = setTimeout(() => {
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    invalidationTimer = null;
  }, 100); // 100ms debounce - batches multiple events into single refetch
};

/**
 * Hook for real-time notification updates via WebSocket
 */
export const useRealtimeNotifications = () => {
  const { user, isAuthenticated } = useOxy();
  const queryClient = useQueryClient();

  const connectSocket = useCallback(() => {
    if (!isAuthenticated || !user?.id || socket?.connected) return;

    try {
      // Connect to backend notifications namespace
      socket = io(`${API_URL_SOCKET}/notifications`, {
        auth: {
          userId: user.id,
        },
        transports: ['websocket'], // Only WebSocket, no polling fallback
        path: '/socket.io',
        reconnectionAttempts: 15, // 15 attempts over ~2 minutes before giving up
        reconnectionDelay: 2000, // Start with 2 second delay (less spammy)
        reconnectionDelayMax: 10000, // Max 10 seconds between attempts
        timeout: 10000, // 10 second connection timeout
      });

      socket.on('connect', () => {
        logger.debug('Connected to notifications socket');
      });

      socket.on('notification', (notification: unknown) => {
        // Validate payload before acting
        const parsed = ZRawNotification.safeParse(notification);
        if (!parsed.success) {
          console.warn('Dropped invalid socket notification', parsed.error?.issues?.[0]);
          return;
        }
        logger.debug('New notification received:', parsed.data);

        // Batch invalidations to prevent 4x queries
        batchedInvalidateNotifications(queryClient);
      });

      socket.on('notificationUpdated', (notification: unknown) => {
        const parsed = ZRawNotification.safeParse(notification);
        if (!parsed.success) {
          console.warn('Dropped invalid socket notificationUpdated', parsed.error?.issues?.[0]);
          return;
        }
        logger.debug('Notification updated:', parsed.data);
        batchedInvalidateNotifications(queryClient);
      });

      socket.on('notificationDeleted', (notificationId: string) => {
        logger.debug('Notification deleted:', notificationId);
        batchedInvalidateNotifications(queryClient);
      });

      socket.on('allNotificationsRead', () => {
        logger.debug('All notifications marked as read');
        batchedInvalidateNotifications(queryClient);
      });

      socket.on('disconnect', () => {
        logger.debug('Disconnected from notifications socket');
      });

      socket.on('connect_error', (error) => {
        console.error('Socket connection error:', error);
      });

    } catch (error) {
      console.error('Failed to connect to notifications socket:', error);
    }
  }, [isAuthenticated, user?.id, queryClient]);

  const disconnectSocket = useCallback(() => {
    if (socket) {
      socket.disconnect();
      socket = null;
    }
  }, []);

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

  return {
    isConnected: socket?.connected || false,
    connect: connectSocket,
    disconnect: disconnectSocket,
  };
};
