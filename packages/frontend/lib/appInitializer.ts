/**
 * App Initialization Service
 * Centralizes all initialization logic for better testability and maintainability
 */

import { Platform } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

import { oxyClient } from '@oxyhq/core';
import { logger } from '@/utils/logger';
import type { User } from '@oxyhq/core';

import { useAppearanceStore } from '@/stores/appearanceStore';
import {
  hasNotificationPermission,
  setupNotifications,
} from '@/utils/notifications';
import { initializeI18n } from './i18n';
import { INITIALIZATION_TIMEOUT } from './constants';
import { fetchMyCloudSyncEnabled } from '@/lib/security/cloudSync';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import { useMessagesStore } from '@/stores/messagesStore';
import { p2pManager } from './p2pMessaging';
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
   * Heavy tasks (Signal Protocol, notifications) are deferred.
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
   * Signal Protocol, P2P messaging, and notifications don't need
   * to block the first render.
   */
  static async initializeDeferred(): Promise<void> {
    try {
      // Run health check first (development only)
      await runStartupHealthCheck();

      await Promise.all([
        setupNotificationsIfNeeded(),
        initializeSignalProtocol(),
      ]);
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

/**
 * Initialize Signal Protocol encryption
 */
async function initializeSignalProtocol(): Promise<void> {
  try {
    // Get current user - try multiple methods
    let user: User | null = null;
    try {
      user = await oxyClient.getCurrentUser();
    } catch {
      // If getCurrentUser fails, user might not be authenticated yet
      logger.info('[AppInitializer] User not authenticated, skipping Signal Protocol initialization');
      return;
    }

    if (!user?.id) {
      logger.info('[AppInitializer] User not authenticated, skipping Signal Protocol initialization');
      return;
    }

    // Initialize device keys
    const deviceKeysStore = useDeviceKeysStore.getState();
    if (!deviceKeysStore.isInitialized) {
      await deviceKeysStore.initialize();
    }

    // What this account's document says about cloud sync, from Allo's backend
    // and not Oxy's — see `lib/security/cloudSync.ts`, which also holds the rule
    // for reading the field and why an absent one leaves cloud sync on.
    //
    // A launch is not blocked on the answer. The store already holds the value
    // this settles on in every case but one, so a settings endpoint having a bad
    // day costs nothing here.
    try {
      useMessagesStore.getState().setCloudSyncEnabled(await fetchMyCloudSyncEnabled());
    } catch (error) {
      logger.warn('[AppInitializer] the cloud sync setting could not be loaded', error);
    }

    // Initialize P2P manager. It re-mints its own access token on each
    // (re)connection, so we only gate on having a session token here.
    if (oxyClient.getAccessToken()) {
      await p2pManager.initialize(user.id);
    }
  } catch (error) {
    logger.error('[AppInitializer] Error initializing Signal Protocol', error);
    // Don't throw - encryption initialization shouldn't block app startup
  }
}


