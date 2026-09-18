import { Platform } from 'react-native';
import { oxyClient } from '@oxy.so/core';

import { useAppearanceStore } from '@/stores/appearanceStore';
import { hasNotificationPermission, setupNotifications } from '@/utils/notifications';
import { logger } from '@/utils/logger';
import { initializeI18n } from './i18n';

/** The app never waits longer than this for the network before it appears. */
const STARTUP_TIMEOUT_MS = 2000;

/**
 * Start-up, in the order the root layout runs it. Nothing here may keep the
 * app from appearing: each step logs its own failure and the app goes on.
 */
export const AppInitializer = {
  async initializeI18n(): Promise<void> {
    await initializeI18n();
  },

  /** The session and the appearance settings, raced against a hard timeout. */
  async initializeApp(): Promise<void> {
    const session = oxyClient.getCurrentUser().catch(() => {
      // Not signed in yet: the auth screen handles it.
    });
    const appearance = oxyClient.getAccessToken()
      ? useAppearanceStore.getState().loadMySettings()
      : Promise.resolve();
    await Promise.race([
      Promise.all([session, appearance]),
      new Promise<void>((resolve) => setTimeout(resolve, STARTUP_TIMEOUT_MS)),
    ]);
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
