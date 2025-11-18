/**
 * Device Keys Store
 * 
 * Manages Signal Protocol device keys and key exchange
 */

import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import {
  initializeDeviceKeys,
  getDeviceKeys,
  storeDeviceKeys,
  DeviceKeys,
  encryptMessage,
  decryptMessage,
} from '@/lib/signalProtocol';
import { api } from '@/utils/api';

interface DeviceKeysState {
  // Device keys
  deviceKeys: DeviceKeys | null;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  initialize: () => Promise<void>;
  registerDevice: () => Promise<boolean>;
  getRecipientKeys: (userId: string) => Promise<any>;
  encryptMessageForRecipient: (message: string, recipientUserId: string) => Promise<string>;
  decryptMessageFromSender: (ciphertext: string, senderUserId: string, senderDeviceId: number) => Promise<string>;
}

export const useDeviceKeysStore = create<DeviceKeysState>()(
  subscribeWithSelector((set, get) => ({
    // Initial state
    deviceKeys: null,
    isInitialized: false,
    isLoading: false,
    error: null,

    // Initialize device keys
    initialize: async () => {
      set({ isLoading: true, error: null });
      try {
        const keys = await initializeDeviceKeys();
        set({ deviceKeys: keys, isInitialized: true, isLoading: false });
        
        // Auto-register device with backend
        await get().registerDevice();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Failed to initialize device keys';
        set({ error: errorMessage, isLoading: false });
        console.error('[DeviceKeys] Error initializing:', error);
      }
    },

    // Register device with backend
    registerDevice: async () => {
      try {
        const keys = get().deviceKeys;
        if (!keys) {
          throw new Error('Device keys not initialized');
        }

        // Get public keys for registration
        const publicKeys = {
          deviceId: keys.deviceId,
          identityKeyPublic: keys.identityKeyPublic,
          signedPreKey: {
            keyId: keys.signedPreKey.keyId,
            publicKey: keys.signedPreKey.publicKey,
            signature: keys.signedPreKey.signature,
          },
          preKeys: keys.preKeys.map(k => ({
            keyId: k.keyId,
            publicKey: k.publicKey,
          })),
          registrationId: keys.registrationId,
        };

        // Register with backend
        await api.post('/devices', publicKeys);
        return true;
      } catch (error) {
        console.error('[DeviceKeys] Error registering device:', error);
        return false;
      }
    },

    // Get recipient's public keys for encryption
    getRecipientKeys: async (userId: string) => {
      try {
        const response = await api.get(`/devices/user/${userId}`);
        const devices = response.data.devices || [];
        
        if (devices.length === 0) {
          throw new Error('No devices found for user');
        }

        // Get the first device (or implement device selection logic)
        const device = devices[0];
        
        // Get preKeys for this device
        const preKeysResponse = await api.get(`/devices/user/${userId}/prekeys/${device.deviceId}`);
        const preKeys = preKeysResponse.data.preKeys || [];
        
        if (preKeys.length === 0) {
          throw new Error('No preKeys available for user');
        }

        return {
          deviceId: device.deviceId,
          identityKeyPublic: device.identityKeyPublic,
          signedPreKey: device.signedPreKey,
          preKey: preKeys[0], // Use first available preKey
        };
      } catch (error) {
        console.error('[DeviceKeys] Error getting recipient keys:', error);
        throw error;
      }
    },

    // Encrypt message for recipient
    encryptMessageForRecipient: async (message: string, recipientUserId: string) => {
      try {
        const recipientKeys = await get().getRecipientKeys(recipientUserId);
        
        // Use signed pre-key's public key for encryption
        // In production, use proper Signal Protocol session management
        const ciphertext = await encryptMessage(message, recipientKeys.identityKeyPublic);
        
        return ciphertext;
      } catch (error) {
        console.error('[DeviceKeys] Error encrypting message:', error);
        throw error;
      }
    },

    // Decrypt message from sender
    decryptMessageFromSender: async (
      ciphertext: string,
      senderUserId: string,
      senderDeviceId: number
    ) => {
      try {
        // Get sender's public key
        const response = await api.get(`/devices/user/${senderUserId}`);
        const devices = response.data.devices || [];
        const senderDevice = devices.find((d: any) => d.deviceId === senderDeviceId);
        
        if (!senderDevice) {
          throw new Error('Sender device not found');
        }

        // Decrypt using sender's public key
        const plaintext = await decryptMessage(ciphertext, senderDevice.identityKeyPublic);
        
        return plaintext;
      } catch (error) {
        console.error('[DeviceKeys] Error decrypting message:', error);
        throw error;
      }
    },
  }))
);

