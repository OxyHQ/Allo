/**
 * App Initialization Service
 * Centralizes all initialization logic for better testability and maintainability
 */

import { Platform } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';

import { oxyClient } from '@oxyhq/core';

import { useAppearanceStore } from '@/store/appearanceStore';
import {
  hasNotificationPermission,
  setupNotifications,
} from '@/utils/notifications';
import { initializeI18n } from './i18n';
import { INITIALIZATION_TIMEOUT } from './constants';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import { useMessagesStore } from '@/stores/messagesStore';
import { p2pManager } from './p2pMessaging';

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
    console.log('User not authenticated during init');
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
  static async initializeApp(
    fontsLoaded: boolean
  ): Promise<InitializationResult> {
    if (!fontsLoaded) {
      return {
        success: false,
        error: new Error('Fonts not loaded'),
      };
    }

    try {
      // Critical path: fetch user and appearance in parallel
      await Promise.all([
        fetchCurrentUser(),
        loadAppearanceSettings(),
      ]);

      // Hide native splash screen
      try {
        await SplashScreen.hideAsync();
      } catch (error) {
        console.warn('Failed to hide native splash screen:', error);
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error : new Error('Unknown initialization error'),
      };
    }
  }

  /**
   * Deferred initialization — runs after the app is visible.
   * Signal Protocol, P2P messaging, and notifications don't need
   * to block the first render.
   */
  static async initializeDeferred(): Promise<void> {
    try {
      await Promise.all([
        setupNotificationsIfNeeded(),
        initializeSignalProtocol(),
      ]);
    } catch (error) {
      console.warn('[AppInitializer] Deferred init error:', error);
    }
  }

  /**
   * Loads eager settings that don't block app initialization
   */
  static async loadEagerSettings(): Promise<void> {
    // Load these in parallel as they don't block app startup
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
    let user: any = null;
    try {
      user = await oxyClient.getCurrentUser();
    } catch {
      // If getCurrentUser fails, user might not be authenticated yet
      console.log('[AppInitializer] User not authenticated, skipping Signal Protocol initialization');
      return;
    }

    if (!user?.id) {
      console.log('[AppInitializer] User not authenticated, skipping Signal Protocol initialization');
      return;
    }

    // Initialize device keys
    const deviceKeysStore = useDeviceKeysStore.getState();
    if (!deviceKeysStore.isInitialized) {
      await deviceKeysStore.initialize();
    }

    // Load cloud sync setting from backend
    try {
      const response = await oxyClient.getClient().get('/profile/settings/me');
      const settings = response.data;
      const cloudSyncEnabled = settings.security?.cloudSyncEnabled || false;
      useMessagesStore.getState().setCloudSyncEnabled(cloudSyncEnabled);
    } catch (error) {
      console.warn('[AppInitializer] Failed to load security settings:', error);
    }

    // Initialize P2P manager
    // Get token from storage or client
    const client = oxyClient.getClient();
    const token = (client.defaults?.headers?.common?.Authorization as string)?.replace('Bearer ', '') ||
                  (client.defaults?.headers?.Authorization as string)?.replace('Bearer ', '');

    if (token) {
      await p2pManager.initialize(user.id, token);
    }
  } catch (error) {
    console.error('[AppInitializer] Error initializing Signal Protocol:', error);
    // Don't throw - encryption initialization shouldn't block app startup
  }
}


