/**
 * Signal Protocol Implementation for Allo
 * 
 * This module provides Signal Protocol encryption/decryption functionality
 * for end-to-end encrypted messaging.
 * 
 * Note: For production, use a proper Signal Protocol library like
 * @privacyresearch/libsignal-protocol-typescript or libsignal-protocol-typescript
 */

import * as SignalProtocol from '@privacyresearch/libsignal-protocol-typescript';
import { Storage } from '@/utils/storage';
import * as SecureStore from 'expo-secure-store';

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
  const existing = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (existing) {
    return parseInt(existing, 10);
  }
  
  // Generate random device ID (1-2147483647)
  const deviceId = Math.floor(Math.random() * 2147483647) + 1;
  await SecureStore.setItemAsync(DEVICE_ID_KEY, deviceId.toString());
  return deviceId;
}

/**
 * Generate Signal Protocol identity key pair
 */
export async function generateIdentityKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const keyPair = await SignalProtocol.KeyHelper.generateIdentityKeyPair();
  return {
    publicKey: Buffer.from(keyPair.pubKey).toString('base64'),
    privateKey: Buffer.from(keyPair.privKey).toString('base64'),
  };
}

/**
 * Generate registration ID
 */
export async function generateRegistrationId(): Promise<number> {
  const existing = await SecureStore.getItemAsync(REGISTRATION_ID_KEY);
  if (existing) {
    return parseInt(existing, 10);
  }
  
  const registrationId = await SignalProtocol.KeyHelper.generateRegistrationId();
  await SecureStore.setItemAsync(REGISTRATION_ID_KEY, registrationId.toString());
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
  const identityKey = {
    pubKey: Buffer.from(identityKeyPair.publicKey, 'base64'),
    privKey: Buffer.from(identityKeyPair.privateKey, 'base64'),
  };
  
  const signedPreKey = await SignalProtocol.KeyHelper.generateSignedPreKey(
    identityKey,
    keyId
  );
  
  return {
    keyId: signedPreKey.keyId,
    publicKey: Buffer.from(signedPreKey.keyPair.pubKey).toString('base64'),
    privateKey: Buffer.from(signedPreKey.keyPair.privKey).toString('base64'),
    signature: Buffer.from(signedPreKey.signature).toString('base64'),
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
  const preKeys = await SignalProtocol.KeyHelper.generatePreKeys(startKeyId, count);
  
  return preKeys.map((preKey) => ({
    keyId: preKey.keyId,
    publicKey: Buffer.from(preKey.keyPair.pubKey).toString('base64'),
    privateKey: Buffer.from(preKey.keyPair.privKey).toString('base64'),
  }));
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
  // Store private keys in SecureStore
  await SecureStore.setItemAsync(IDENTITY_KEY_PAIR_KEY, JSON.stringify({
    public: keys.identityKeyPublic,
    private: keys.identityKeyPrivate,
  }));
  
  await SecureStore.setItemAsync(SIGNED_PRE_KEY_KEY, JSON.stringify(keys.signedPreKey));
  await SecureStore.setItemAsync(PRE_KEYS_KEY, JSON.stringify(keys.preKeys));
  
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
    const identityKeyPairStr = await SecureStore.getItemAsync(IDENTITY_KEY_PAIR_KEY);
    const signedPreKeyStr = await SecureStore.getItemAsync(SIGNED_PRE_KEY_KEY);
    const preKeysStr = await SecureStore.getItemAsync(PRE_KEYS_KEY);
    const deviceIdStr = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    const registrationIdStr = await SecureStore.getItemAsync(REGISTRATION_ID_KEY);
    
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
 * Encrypt a message for a recipient
 * 
 * @param message - Plaintext message to encrypt
 * @param recipientUserId - Oxy user ID of recipient
 * @param recipientDeviceId - Device ID of recipient
 * @param recipientPublicKeys - Public keys of recipient device
 */
export async function encryptMessage(
  message: string,
  recipientUserId: string,
  recipientDeviceId: number,
  recipientPublicKeys: {
    identityKeyPublic: string;
    signedPreKey: { keyId: number; publicKey: string; signature: string };
    preKey?: { keyId: number; publicKey: string };
  }
): Promise<string> {
  try {
    // Get our device keys
    const ourKeys = await getDeviceKeys();
    if (!ourKeys) {
      throw new Error('Device keys not initialized');
    }
    
    // Create session builder
    const address = new SignalProtocol.SignalProtocolAddress(recipientUserId, recipientDeviceId);
    const sessionBuilder = new SignalProtocol.SessionBuilder(
      new InMemorySignalProtocolStore(), // TODO: Implement proper store
      address
    );
    
    // Build session with recipient's public keys
    const recipientIdentityKey = Buffer.from(recipientPublicKeys.identityKeyPublic, 'base64');
    const recipientSignedPreKey = {
      keyId: recipientPublicKeys.signedPreKey.keyId,
      publicKey: Buffer.from(recipientPublicKeys.signedPreKey.publicKey, 'base64'),
      signature: Buffer.from(recipientPublicKeys.signedPreKey.signature, 'base64'),
    };
    
    const recipientPreKey = recipientPublicKeys.preKey ? {
      keyId: recipientPublicKeys.preKey.keyId,
      publicKey: Buffer.from(recipientPublicKeys.preKey.publicKey, 'base64'),
    } : undefined;
    
    await sessionBuilder.processPreKeyBundle({
      identityKey: recipientIdentityKey,
      signedPreKey: recipientSignedPreKey,
      preKey: recipientPreKey,
    });
    
    // Create session cipher
    const sessionCipher = new SignalProtocol.SessionCipher(
      new InMemorySignalProtocolStore(),
      address
    );
    
    // Encrypt message
    const plaintext = Buffer.from(message, 'utf-8');
    const ciphertext = await sessionCipher.encrypt(plaintext);
    
    // Return base64 encoded ciphertext
    return Buffer.from(ciphertext.serialize()).toString('base64');
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
  senderUserId: string,
  senderDeviceId: number
): Promise<string> {
  try {
    // Get our device keys
    const ourKeys = await getDeviceKeys();
    if (!ourKeys) {
      throw new Error('Device keys not initialized');
    }
    
    // Create session cipher
    const address = new SignalProtocol.SignalProtocolAddress(senderUserId, senderDeviceId);
    const sessionCipher = new SignalProtocol.SessionCipher(
      new InMemorySignalProtocolStore(), // TODO: Implement proper store
      address
    );
    
    // Decrypt message
    const ciphertextBuffer = Buffer.from(ciphertext, 'base64');
    const plaintext = await sessionCipher.decryptPreKeyWhisperMessage(ciphertextBuffer);
    
    return Buffer.from(plaintext).toString('utf-8');
  } catch (error) {
    console.error('[SignalProtocol] Error decrypting message:', error);
    throw error;
  }
}

/**
 * Simple in-memory store for Signal Protocol
 * TODO: Replace with persistent store using SQLite
 */
class InMemorySignalProtocolStore implements SignalProtocol.SignalProtocolStore {
  private identityKey: SignalProtocol.IdentityKeyPair | null = null;
  private localRegistrationId: number | null = null;
  private sessions: Map<string, SignalProtocol.SessionRecord> = new Map();
  private preKeys: Map<number, SignalProtocol.PreKeyRecord> = new Map();
  private signedPreKeys: Map<number, SignalProtocol.SignedPreKeyRecord> = new Map();
  
  async getIdentityKeyPair(): Promise<SignalProtocol.IdentityKeyPair | null> {
    return this.identityKey;
  }
  
  async getLocalRegistrationId(): Promise<number | null> {
    return this.localRegistrationId;
  }
  
  async saveIdentity(address: SignalProtocol.SignalProtocolAddress, identityKey: SignalProtocol.IdentityKey): Promise<boolean> {
    // TODO: Implement
    return true;
  }
  
  async isTrustedIdentity(address: SignalProtocol.SignalProtocolAddress, identityKey: SignalProtocol.IdentityKey): Promise<boolean> {
    // TODO: Implement trust verification
    return true;
  }
  
  async getIdentityKey(address: SignalProtocol.SignalProtocolAddress): Promise<SignalProtocol.IdentityKey | null> {
    // TODO: Implement
    return null;
  }
  
  async loadSession(address: SignalProtocol.SignalProtocolAddress): Promise<SignalProtocol.SessionRecord | null> {
    const key = `${address.getName()}:${address.getDeviceId()}`;
    return this.sessions.get(key) || null;
  }
  
  async storeSession(address: SignalProtocol.SignalProtocolAddress, record: SignalProtocol.SessionRecord): Promise<void> {
    const key = `${address.getName()}:${address.getDeviceId()}`;
    this.sessions.set(key, record);
  }
  
  async containsSession(address: SignalProtocol.SignalProtocolAddress): Promise<boolean> {
    const key = `${address.getName()}:${address.getDeviceId()}`;
    return this.sessions.has(key);
  }
  
  async deleteSession(address: SignalProtocol.SignalProtocolAddress): Promise<void> {
    const key = `${address.getName()}:${address.getDeviceId()}`;
    this.sessions.delete(key);
  }
  
  async deleteAllSessions(name: string): Promise<void> {
    // TODO: Implement
  }
  
  async loadPreKey(keyId: number): Promise<SignalProtocol.PreKeyRecord | null> {
    return this.preKeys.get(keyId) || null;
  }
  
  async storePreKey(keyId: number, record: SignalProtocol.PreKeyRecord): Promise<void> {
    this.preKeys.set(keyId, record);
  }
  
  async removePreKey(keyId: number): Promise<void> {
    this.preKeys.delete(keyId);
  }
  
  async containsPreKey(keyId: number): Promise<boolean> {
    return this.preKeys.has(keyId);
  }
  
  async loadSignedPreKey(keyId: number): Promise<SignalProtocol.SignedPreKeyRecord | null> {
    return this.signedPreKeys.get(keyId) || null;
  }
  
  async storeSignedPreKey(keyId: number, record: SignalProtocol.SignedPreKeyRecord): Promise<void> {
    this.signedPreKeys.set(keyId, record);
  }
  
  async removeSignedPreKey(keyId: number): Promise<void> {
    this.signedPreKeys.delete(keyId);
  }
  
  async containsSignedPreKey(keyId: number): Promise<boolean> {
    return this.signedPreKeys.has(keyId);
  }
}

