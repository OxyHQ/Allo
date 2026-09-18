/**
 * App Initialization Service
 * Centralizes all initialization logic for better testability and maintainability
 */

import { Platform } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

import { oxyClient } from '@oxy.so/core';
import { logger } from '@/utils/logger';

import { useAppearanceStore } from '@/stores/appearanceStore';
import {
  hasNotificationPermission,
  setupNotifications,
} from '@/utils/notifications';
import { initializeI18n } from './i18n';
import { INITIALIZATION_TIMEOUT } from './constants';
import { runStartupHealthCheck } from '@/utils/appHealthCheck';

export interface InitializationResult {
  success: boolean;
  error?: Error;
}

export interface AppInitializationState {
  fontsLoaded: boolean;
  i18nInitialized: boolean;
  notificationsSetup: boolean;
  authReady: boolean;
  appearanceLoaded: boolean;
  videoMuteLoaded: boolean;
}

/**
 * Sets up notifications for native platforms
 */
async function setupNotificationsIfNeeded(): Promise<void> {
  if (Platform.OS === 'web') {
    return;
  }

  try {
    await setupNotifications();
    await hasNotificationPermission();
  } catch (error) {
    console.warn('Failed to setup notifications:', error);
  }
}

/**
 * Loads user appearance settings
 */
async function loadAppearanceSettings(): Promise<void> {
  try {
    // Nothing to load before sign-in: the request would only answer 401, and
    // every browser prints that to the console at boot. The settings screens
    // load on demand once there is a session.
    const token = await oxyClient.getAccessToken();
    if (!token) return;
    await useAppearanceStore.getState().loadMySettings();
  } catch (error) {
    console.warn('Failed to load appearance settings:', error);
  }
}

/**
 * Fetches current user
 */
async function fetchCurrentUser(): Promise<void> {
  try {
    await oxyClient.getCurrentUser();
  } catch (error) {
    // User might not be authenticated yet, which is fine
    logger.info('User not authenticated during init');
  }
}

/**
 * Main app initialization function
 * Coordinates all initialization steps
 */
export class AppInitializer {
  /**
   * Initializes i18n
   */
  static async initializeI18n(): Promise<InitializationResult> {
    try {
      await initializeI18n();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error('Unknown i18n error'),
      };
    }
  }

  /**
   * Initializes the entire app
   * Only blocks on critical-path work (user + appearance).
   * Notification setup is deferred.
   */
  static async initializeApp(): Promise<InitializationResult> {
    try {
      // Hard timeout: app MUST launch within 2s regardless of network.
      // WhatsApp/Telegram never block startup on API calls.
      const STARTUP_TIMEOUT_MS = 2000;

      await Promise.race([
        Promise.all([
          fetchCurrentUser(),
          loadAppearanceSettings(),
        ]),
        new Promise<void>((resolve) => setTimeout(resolve, STARTUP_TIMEOUT_MS)),
      ]);

      // Hide native splash screen - always, even if API calls timed out
      try {
        await SplashScreen.hideAsync();
      } catch (error) {
        console.warn('Failed to hide native splash screen:', error);
      }

      return { success: true };
    } catch (error) {
      // Always succeed - never block the user from using the app
      try {
        await SplashScreen.hideAsync();
      } catch (error) {
        console.warn('Failed to hide native splash screen:', error);
      }
      return { success: true };
    }
  }

  /**
   * Deferred initialization — runs after the app is visible.
   * Notifications don't need to block the first render. The messaging client
   * is not started here: `lib/allo/AlloRoot.tsx` owns it and starts it once the
   * Oxy session names an account.
   */
  static async initializeDeferred(): Promise<void> {
    try {
      // Run health check first (development only)
      await runStartupHealthCheck();

      await setupNotificationsIfNeeded();
    } catch (error) {
      console.warn('[AppInitializer] Deferred init error:', error);
    }
  }

  /**
   * Loads eager settings that don't block app initialization.
   * Skips if user is not yet authenticated (token not available).
   */
  static async loadEagerSettings(): Promise<void> {
    // Only load if we have an auth token — otherwise these calls will 401
    if (!oxyClient.getAccessToken()) return;

    await Promise.allSettled([
      loadAppearanceSettings(),
    ]);
  }
}
