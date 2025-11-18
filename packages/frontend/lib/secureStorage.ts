/**
 * Secure Storage Wrapper
 * 
 * Provides a unified interface for secure storage that works on both native and web.
 * On native platforms, uses Expo SecureStore (if available).
 * On web or when SecureStore is unavailable, falls back to AsyncStorage.
 */

import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';

const isWeb = Platform.OS === 'web';
let isSecureStoreAvailable: boolean | null = null;

/**
 * Check if SecureStore is available on this platform
 */
async function checkSecureStoreAvailability(): Promise<boolean> {
  if (isWeb) {
    return false; // SecureStore is not available on web
  }
  
  if (isSecureStoreAvailable !== null) {
    return isSecureStoreAvailable;
  }
  
  try {
    isSecureStoreAvailable = await SecureStore.isAvailableAsync();
    return isSecureStoreAvailable;
  } catch (error) {
    console.warn('[SecureStorage] Error checking SecureStore availability:', error);
    isSecureStoreAvailable = false;
    return false;
  }
}

/**
 * Get an item from secure storage
 */
export async function getSecureItem(key: string): Promise<string | null> {
  try {
    const useSecureStore = await checkSecureStoreAvailability();
    
    if (useSecureStore) {
      // On native platforms with SecureStore available
      return await SecureStore.getItemAsync(key);
    } else {
      // On web or when SecureStore is unavailable, use AsyncStorage
      return await AsyncStorage.getItem(key);
    }
  } catch (error) {
    console.error(`[SecureStorage] Error getting item ${key}:`, error);
    // Fallback to AsyncStorage if SecureStore fails
    try {
      return await AsyncStorage.getItem(key);
    } catch (fallbackError) {
      console.error(`[SecureStorage] Fallback also failed for ${key}:`, fallbackError);
      return null;
    }
  }
}

/**
 * Set an item in secure storage
 */
export async function setSecureItem(key: string, value: string): Promise<boolean> {
  try {
    const useSecureStore = await checkSecureStoreAvailability();
    
    if (useSecureStore) {
      // On native platforms with SecureStore available
      await SecureStore.setItemAsync(key, value);
      return true;
    } else {
      // On web or when SecureStore is unavailable, use AsyncStorage
      await AsyncStorage.setItem(key, value);
      return true;
    }
  } catch (error) {
    console.error(`[SecureStorage] Error setting item ${key}:`, error);
    // Fallback to AsyncStorage if SecureStore fails
    try {
      await AsyncStorage.setItem(key, value);
      return true;
    } catch (fallbackError) {
      console.error(`[SecureStorage] Fallback also failed for ${key}:`, fallbackError);
      return false;
    }
  }
}

/**
 * Remove an item from secure storage
 */
export async function removeSecureItem(key: string): Promise<boolean> {
  try {
    const useSecureStore = await checkSecureStoreAvailability();
    
    if (useSecureStore) {
      // On native platforms with SecureStore available
      await SecureStore.deleteItemAsync(key);
      return true;
    } else {
      // On web or when SecureStore is unavailable, use AsyncStorage
      await AsyncStorage.removeItem(key);
      return true;
    }
  } catch (error) {
    console.error(`[SecureStorage] Error removing item ${key}:`, error);
    // Fallback to AsyncStorage if SecureStore fails
    try {
      await AsyncStorage.removeItem(key);
      return true;
    } catch (fallbackError) {
      console.error(`[SecureStorage] Fallback also failed for ${key}:`, fallbackError);
      return false;
    }
  }
}

