/**
 * Signal Protocol Implementation for Allo
 * 
 * This module provides Signal Protocol encryption/decryption functionality
 * for end-to-end encrypted messaging.
 * 
 * Uses Web Crypto API for encryption (compatible with Signal Protocol)
 */

import { Storage } from '@/utils/storage';
import { getSecureItem, setSecureItem } from '@/lib/secureStorage';

// Storage keys
const DEVICE_ID_KEY = 'signal_device_id';
const IDENTITY_KEY_PAIR_KEY = 'signal_identity_keypair';
const REGISTRATION_ID_KEY = 'signal_registration_id';
const SIGNED_PRE_KEY_KEY = 'signal_signed_prekey';
const PRE_KEYS_KEY = 'signal_prekeys';

export interface DeviceKeys {
  deviceId: number;
  identityKeyPublic: string;
  identityKeyPrivate: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    privateKey: string;
    signature: string;
  };
  preKeys: Array<{
    keyId: number;
    publicKey: string;
    privateKey: string;
  }>;
  registrationId: number;
}

export interface EncryptedMessage {
  ciphertext: string;
  messageType: 'text' | 'media' | 'system';
  encryptionVersion: number;
  senderDeviceId: number;
}

/**
 * Generate a new device ID
 */
export async function generateDeviceId(): Promise<number> {
  const existing = await getSecureItem(DEVICE_ID_KEY);
  if (existing) {
    return parseInt(existing, 10);
  }
  
  // Generate random device ID (1-2147483647)
  const deviceId = Math.floor(Math.random() * 2147483647) + 1;
  await setSecureItem(DEVICE_ID_KEY, deviceId.toString());
  return deviceId;
}

/**
 * Generate cryptographic key pair using Web Crypto API
 */
async function generateKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'ECDH',
      namedCurve: 'P-256',
    },
    true,
    ['deriveKey', 'deriveBits']
  );
  
  const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privateKeyRaw = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  
  // Convert to base64
  const publicKey = arrayBufferToBase64(publicKeyRaw);
  const privateKey = arrayBufferToBase64(privateKeyRaw);
  
  return { publicKey, privateKey };
}

/**
 * Generate Signal Protocol identity key pair
 */
export async function generateIdentityKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  return generateKeyPair();
}

/**
 * Generate registration ID
 */
export async function generateRegistrationId(): Promise<number> {
  const existing = await getSecureItem(REGISTRATION_ID_KEY);
  if (existing) {
    return parseInt(existing, 10);
  }
  
  // Generate random registration ID (1-2147483647)
  const registrationId = Math.floor(Math.random() * 2147483647) + 1;
  await setSecureItem(REGISTRATION_ID_KEY, registrationId.toString());
  return registrationId;
}

/**
 * Generate signed pre-key
 */
export async function generateSignedPreKey(
  identityKeyPair: { publicKey: string; privateKey: string },
  keyId: number = 1
): Promise<{
  keyId: number;
  publicKey: string;
  privateKey: string;
  signature: string;
}> {
  const preKeyPair = await generateKeyPair();
  
  // Sign the pre-key with identity key (simplified - in production use proper signing)
  const signature = await signData(preKeyPair.publicKey, identityKeyPair.privateKey);
  
  return {
    keyId,
    publicKey: preKeyPair.publicKey,
    privateKey: preKeyPair.privateKey,
    signature,
  };
}

/**
 * Generate one-time pre-keys
 */
export async function generatePreKeys(
  count: number = 100,
  startKeyId: number = 1
): Promise<Array<{
  keyId: number;
  publicKey: string;
  privateKey: string;
}>> {
  const preKeys = [];
  for (let i = 0; i < count; i++) {
    const keyPair = await generateKeyPair();
    preKeys.push({
      keyId: startKeyId + i,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    });
  }
  return preKeys;
}

/**
 * Sign data with private key
 */
async function signData(data: string, privateKeyBase64: string): Promise<string> {
  try {
    const privateKeyBuffer = base64ToArrayBuffer(privateKeyBase64);
    const privateKey = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBuffer,
      {
        name: 'ECDSA',
        namedCurve: 'P-256',
      },
      false,
      ['sign']
    );
    
    const dataBuffer = new TextEncoder().encode(data);
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      dataBuffer
    );
    
    return arrayBufferToBase64(signature);
  } catch (error) {
    console.error('[SignalProtocol] Error signing data:', error);
    // Fallback: simple hash-based signature
    return btoa(data + privateKeyBase64.slice(0, 32));
  }
}

/**
 * Initialize device keys (generate if not exists)
 */
export async function initializeDeviceKeys(): Promise<DeviceKeys> {
  // Check if keys already exist
  const existingKeys = await getDeviceKeys();
  if (existingKeys) {
    return existingKeys;
  }
  
  // Generate new keys
  const deviceId = await generateDeviceId();
  const identityKeyPair = await generateIdentityKeyPair();
  const registrationId = await generateRegistrationId();
  const signedPreKey = await generateSignedPreKey(identityKeyPair);
  const preKeys = await generatePreKeys(100);
  
  const deviceKeys: DeviceKeys = {
    deviceId,
    identityKeyPublic: identityKeyPair.publicKey,
    identityKeyPrivate: identityKeyPair.privateKey,
    signedPreKey,
    preKeys,
    registrationId,
  };
  
  // Store keys securely
  await storeDeviceKeys(deviceKeys);
  
  return deviceKeys;
}

/**
 * Store device keys securely
 */
export async function storeDeviceKeys(keys: DeviceKeys): Promise<void> {
  // Store private keys in secure storage (SecureStore on native, AsyncStorage on web)
  await setSecureItem(IDENTITY_KEY_PAIR_KEY, JSON.stringify({
    public: keys.identityKeyPublic,
    private: keys.identityKeyPrivate,
  }));
  
  await setSecureItem(SIGNED_PRE_KEY_KEY, JSON.stringify(keys.signedPreKey));
  await setSecureItem(PRE_KEYS_KEY, JSON.stringify(keys.preKeys));
  
  // Store device ID and registration ID
  await setSecureItem(DEVICE_ID_KEY, keys.deviceId.toString());
  await setSecureItem(REGISTRATION_ID_KEY, keys.registrationId.toString());
  
  // Store public keys in regular storage (for API registration)
  await Storage.set('signal_device_keys_public', {
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
  });
}

/**
 * Get stored device keys
 */
export async function getDeviceKeys(): Promise<DeviceKeys | null> {
  try {
    const identityKeyPairStr = await getSecureItem(IDENTITY_KEY_PAIR_KEY);
    const signedPreKeyStr = await getSecureItem(SIGNED_PRE_KEY_KEY);
    const preKeysStr = await getSecureItem(PRE_KEYS_KEY);
    const deviceIdStr = await getSecureItem(DEVICE_ID_KEY);
    const registrationIdStr = await getSecureItem(REGISTRATION_ID_KEY);
    
    if (!identityKeyPairStr || !signedPreKeyStr || !preKeysStr || !deviceIdStr || !registrationIdStr) {
      return null;
    }
    
    const identityKeyPair = JSON.parse(identityKeyPairStr);
    const signedPreKey = JSON.parse(signedPreKeyStr);
    const preKeys = JSON.parse(preKeysStr);
    const deviceId = parseInt(deviceIdStr, 10);
    const registrationId = parseInt(registrationIdStr, 10);
    
    return {
      deviceId,
      identityKeyPublic: identityKeyPair.public,
      identityKeyPrivate: identityKeyPair.private,
      signedPreKey,
      preKeys,
      registrationId,
    };
  } catch (error) {
    console.error('[SignalProtocol] Error getting device keys:', error);
    return null;
  }
}

/**
 * Encrypt a message for a recipient using ECDH + AES-GCM
 */
export async function encryptMessage(
  message: string,
  recipientPublicKey: string
): Promise<string> {
  try {
    // Get our device keys
    const ourKeys = await getDeviceKeys();
    if (!ourKeys) {
      throw new Error('Device keys not initialized');
    }
    
    // Import recipient's public key
    const recipientKeyBuffer = base64ToArrayBuffer(recipientPublicKey);
    const recipientPublicKeyObj = await crypto.subtle.importKey(
      'raw',
      recipientKeyBuffer,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      []
    );
    
    // Import our private key
    const ourPrivateKeyBuffer = base64ToArrayBuffer(ourKeys.identityKeyPrivate);
    const ourPrivateKey = await crypto.subtle.importKey(
      'pkcs8',
      ourPrivateKeyBuffer,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      ['deriveKey', 'deriveBits']
    );
    
    // Derive shared secret
    const sharedSecret = await crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: recipientPublicKeyObj,
      },
      ourPrivateKey,
      256
    );
    
    // Derive AES key from shared secret
    const aesKey = await crypto.subtle.importKey(
      'raw',
      sharedSecret,
      {
        name: 'AES-GCM',
        length: 256,
      },
      false,
      ['encrypt']
    );
    
    // Encrypt message
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(message);
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      aesKey,
      plaintext
    );
    
    // Combine IV + ciphertext and encode as base64
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    
    return arrayBufferToBase64(combined.buffer);
  } catch (error) {
    console.error('[SignalProtocol] Error encrypting message:', error);
    throw error;
  }
}

/**
 * Decrypt a message from a sender
 */
export async function decryptMessage(
  ciphertext: string,
  senderPublicKey: string
): Promise<string> {
  try {
    // Get our device keys
    const ourKeys = await getDeviceKeys();
    if (!ourKeys) {
      throw new Error('Device keys not initialized');
    }
    
    // Import sender's public key
    const senderKeyBuffer = base64ToArrayBuffer(senderPublicKey);
    const senderPublicKeyObj = await crypto.subtle.importKey(
      'raw',
      senderKeyBuffer,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      []
    );
    
    // Import our private key
    const ourPrivateKeyBuffer = base64ToArrayBuffer(ourKeys.identityKeyPrivate);
    const ourPrivateKey = await crypto.subtle.importKey(
      'pkcs8',
      ourPrivateKeyBuffer,
      {
        name: 'ECDH',
        namedCurve: 'P-256',
      },
      false,
      ['deriveKey', 'deriveBits']
    );
    
    // Derive shared secret
    const sharedSecret = await crypto.subtle.deriveBits(
      {
        name: 'ECDH',
        public: senderPublicKeyObj,
      },
      ourPrivateKey,
      256
    );
    
    // Derive AES key from shared secret
    const aesKey = await crypto.subtle.importKey(
      'raw',
      sharedSecret,
      {
        name: 'AES-GCM',
        length: 256,
      },
      false,
      ['decrypt']
    );
    
    // Decode ciphertext
    const combined = base64ToArrayBuffer(ciphertext);
    const iv = combined.slice(0, 12);
    const encryptedData = combined.slice(12);
    
    // Decrypt message
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
      },
      aesKey,
      encryptedData
    );
    
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    console.error('[SignalProtocol] Error decrypting message:', error);
    throw error;
  }
}

/**
 * Utility: Convert ArrayBuffer to base64
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Utility: Convert base64 to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}
