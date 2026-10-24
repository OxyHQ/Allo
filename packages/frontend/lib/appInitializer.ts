import { Platform } from 'react-native';

import { hasNotificationPermission, setupNotifications } from '@/utils/notifications';
import { logger } from '@/utils/logger';
import { initializeI18n } from './i18n';

/**
 * Start-up, in the order the root layout runs it. Only the bundled
 * translations are waited for; nothing here waits on the network, and each
 * step logs its own failure and the app goes on.
 */
export const AppInitializer = {
  async initializeI18n(): Promise<void> {
    await initializeI18n();
  },

  /** Work that can wait until the first screen is up. */
  async initializeDeferred(): Promise<void> {
    if (Platform.OS === 'web') return;
    try {
      await setupNotifications();
      await hasNotificationPermission();
    } catch (error) {
      logger.warn('[AppInitializer] notifications setup failed', error);
    }
  },
};
