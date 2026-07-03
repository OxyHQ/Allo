/**
 * Signal Protocol Implementation for Allo
 *
 * End-to-end encryption primitives for messaging. Pure-JS and fully
 * platform-agnostic (web + React Native/Hermes): there is no dependency on
 * `crypto.subtle`, which is undefined on Hermes.
 *
 * Wire format (unchanged, interoperable with data produced by the previous
 * WebCrypto implementation):
 *   - Keys: P-256. Public key is the 65-byte uncompressed SEC1 point
 *     (`0x04 || X || Y`), private key is the raw 32-byte scalar. Both base64.
 *   - Key agreement: ECDH over P-256. The shared secret is the 32-byte X
 *     coordinate of the shared point, used directly as the AES-256 key
 *     (no KDF — matches the legacy WebCrypto ciphertext).
 *   - AEAD: AES-256-GCM. Ciphertext blob = `IV(12) || ciphertext || tag(16)`,
 *     base64.
 *   - Signatures: ECDSA-P256 over SHA-256, 64-byte compact `r || s`, base64.
 */

import { p256 } from '@noble/curves/nist.js';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/hashes/utils.js';

import { Storage } from '@/utils/storage';
import { getSecureItem, setSecureItem } from '@/lib/secureStorage';

// Storage keys
const DEVICE_ID_KEY = 'signal_device_id';
const IDENTITY_KEY_PAIR_KEY = 'signal_identity_keypair';
const REGISTRATION_ID_KEY = 'signal_registration_id';
const SIGNED_PRE_KEY_KEY = 'signal_signed_prekey';
const PRE_KEYS_KEY = 'signal_prekeys';

// Wire-format constants
const IV_LENGTH = 12; // AES-GCM nonce
const GCM_TAG_LENGTH = 16; // AES-GCM authentication tag
const SCALAR_LENGTH = 32; // P-256 private scalar
// Largest 31-bit id (matches Signal's registration/device id range).
const MAX_ID = 2147483647; // 2^31 - 1
const UINT32_CEILING = 0x100000000; // 2^32

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
 * Standard RFC 4648 base64 codec over byte arrays. Implemented directly rather
 * than via `btoa`/`atob`, which are not present on Hermes.
 */
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < BASE64_CHARS.length; i++) {
    table[BASE64_CHARS.charCodeAt(i)] = i;
  }
  return table;
})();

function bytesToBase64(bytes: Uint8Array): string {
  let output = '';
  const length = bytes.length;
  for (let i = 0; i < length; i += 3) {
    const byte0 = bytes[i];
    const byte1 = i + 1 < length ? bytes[i + 1] : 0;
    const byte2 = i + 2 < length ? bytes[i + 2] : 0;
    output += BASE64_CHARS[byte0 >> 2];
    output += BASE64_CHARS[((byte0 & 0x03) << 4) | (byte1 >> 4)];
    output += i + 1 < length ? BASE64_CHARS[((byte1 & 0x0f) << 2) | (byte2 >> 6)] : '=';
    output += i + 2 < length ? BASE64_CHARS[byte2 & 0x3f] : '=';
  }
  return output;
}

function base64ToBytes(base64: string): Uint8Array {
  // Collect the 6-bit symbols, ignoring padding and any whitespace.
  const symbols: number[] = [];
  for (let i = 0; i < base64.length; i++) {
    const value = BASE64_LOOKUP[base64.charCodeAt(i)];
    if (value !== -1) {
      symbols.push(value);
    }
  }
  const bytes = new Uint8Array(Math.floor((symbols.length * 3) / 4));
  let byteIndex = 0;
  for (let i = 0; i < symbols.length; i += 4) {
    const symbol0 = symbols[i];
    const symbol1 = symbols[i + 1] ?? -1;
    const symbol2 = symbols[i + 2] ?? -1;
    const symbol3 = symbols[i + 3] ?? -1;
    if (symbol1 === -1) {
      break;
    }
    bytes[byteIndex++] = (symbol0 << 2) | (symbol1 >> 4);
    if (symbol2 !== -1) {
      bytes[byteIndex++] = ((symbol1 & 0x0f) << 4) | (symbol2 >> 2);
    }
    if (symbol3 !== -1) {
      bytes[byteIndex++] = ((symbol2 & 0x03) << 6) | symbol3;
    }
  }
  return bytes;
}

/**
 * Extract the raw 32-byte EC private scalar from a PKCS8 DER blob produced by
 * WebCrypto `exportKey('pkcs8')`. The scalar lives in the inner ECPrivateKey
 * structure; the DER is walked minimally with tag validation rather than a
 * fixed magic offset.
 */
function extractRawScalarFromPkcs8(der: Uint8Array): Uint8Array {
  let offset = 0;

  const readLength = (): number => {
    if (offset >= der.length) {
      throw new Error('malformed pkcs8 (truncated length)');
    }
    let length = der[offset++];
    if (length & 0x80) {
      const byteCount = length & 0x7f;
      length = 0;
      for (let i = 0; i < byteCount; i++) {
        if (offset >= der.length) {
          throw new Error('malformed pkcs8 (truncated length)');
        }
        length = (length << 8) | der[offset++];
      }
    }
    // A NaN/negative/overrunning length (from a truncated or crafted blob) must
    // never slip through to the scalar read and silently yield a zero scalar.
    if (!Number.isFinite(length) || length < 0 || offset + length > der.length) {
      throw new Error('malformed pkcs8 (length out of range)');
    }
    return length;
  };
  const expectTag = (tag: number): void => {
    if (offset >= der.length) {
      throw new Error('malformed pkcs8 (truncated)');
    }
    if (der[offset++] !== tag) {
      throw new Error(`Invalid PKCS8 private key: expected DER tag 0x${tag.toString(16)}`);
    }
  };
  // Advance past a field's content. Must read the length into a local BEFORE
  // advancing offset: `offset += readLength()` would capture the pre-call
  // offset and clobber readLength()'s own advance over the length bytes.
  const skipField = (): void => {
    const length = readLength();
    if (offset + length > der.length) {
      throw new Error('malformed pkcs8 (field overflow)');
    }
    offset += length;
  };

  expectTag(0x30); // PrivateKeyInfo SEQUENCE
  readLength();
  expectTag(0x02); // version INTEGER
  skipField();
  expectTag(0x30); // privateKeyAlgorithm SEQUENCE
  skipField();
  expectTag(0x04); // privateKey OCTET STRING (wraps the ECPrivateKey)
  readLength();
  expectTag(0x30); // ECPrivateKey SEQUENCE
  readLength();
  expectTag(0x02); // ECPrivateKey version INTEGER
  skipField();
  expectTag(0x04); // privateKey OCTET STRING (the scalar)
  const scalarLength = readLength();
  if (scalarLength < 1 || scalarLength > SCALAR_LENGTH + 1 || offset + scalarLength > der.length) {
    throw new Error('Invalid PKCS8 private key: unexpected EC scalar length');
  }

  const scalar = der.subarray(offset, offset + scalarLength);
  if (scalar.length === SCALAR_LENGTH) {
    return new Uint8Array(scalar);
  }
  // Normalize to exactly 32 bytes (a leading zero may have been added/trimmed).
  const normalized = new Uint8Array(SCALAR_LENGTH);
  if (scalar.length < SCALAR_LENGTH) {
    normalized.set(scalar, SCALAR_LENGTH - scalar.length);
  } else {
    normalized.set(scalar.subarray(scalar.length - SCALAR_LENGTH));
  }
  return normalized;
}

/**
 * Decode a stored private key to a raw 32-byte P-256 scalar. Accepts both the
 * current raw-scalar format and the legacy WebCrypto PKCS8 DER format.
 */
function loadPrivateScalar(privateKeyBase64: string): Uint8Array {
  const decoded = base64ToBytes(privateKeyBase64);
  if (decoded.length === SCALAR_LENGTH) {
    return decoded;
  }
  return extractRawScalarFromPkcs8(decoded);
}

/**
 * Generate a cryptographically secure id in [1, 2147483647] from a CSPRNG.
 * Uses rejection sampling to avoid modulo bias.
 */
function generateSecureId(): number {
  const rejectionLimit = Math.floor(UINT32_CEILING / MAX_ID) * MAX_ID;
  let value: number;
  do {
    const bytes = randomBytes(4);
    value = bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
  } while (value >= rejectionLimit);
  return (value % MAX_ID) + 1;
}

/**
 * Generate a new device ID (persisted in secure storage on first use).
 */
export async function generateDeviceId(): Promise<number> {
  const existing = await getSecureItem(DEVICE_ID_KEY);
  if (existing) {
    return parseInt(existing, 10);
  }

  const deviceId = generateSecureId();
  await setSecureItem(DEVICE_ID_KEY, deviceId.toString());
  return deviceId;
}

/**
 * Generate a P-256 key pair as base64 (65-byte uncompressed public key,
 * 32-byte raw private scalar).
 */
export function generateKeyPair(): { publicKey: string; privateKey: string } {
  const privateScalar = p256.utils.randomSecretKey();
  const publicKey = p256.getPublicKey(privateScalar, false);
  return {
    publicKey: bytesToBase64(publicKey),
    privateKey: bytesToBase64(privateScalar),
  };
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
 * Generate registration ID (persisted in secure storage on first use).
 */
export async function generateRegistrationId(): Promise<number> {
  const existing = await getSecureItem(REGISTRATION_ID_KEY);
  if (existing) {
    return parseInt(existing, 10);
  }

  const registrationId = generateSecureId();
  await setSecureItem(REGISTRATION_ID_KEY, registrationId.toString());
  return registrationId;
}

/**
 * Generate signed pre-key (signed with the identity key via ECDSA-P256).
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
  const preKeyPair = generateKeyPair();
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
  const preKeys: Array<{ keyId: number; publicKey: string; privateKey: string }> = [];
  for (let i = 0; i < count; i++) {
    const keyPair = generateKeyPair();
    preKeys.push({
      keyId: startKeyId + i,
      publicKey: keyPair.publicKey,
      privateKey: keyPair.privateKey,
    });
  }
  return preKeys;
}

/**
 * Sign data with a P-256 private key (ECDSA over SHA-256, 64-byte compact
 * `r || s`, base64). Throws on failure — there is no insecure fallback.
 */
export async function signData(data: string, privateKeyBase64: string): Promise<string> {
  const privateScalar = loadPrivateScalar(privateKeyBase64);
  const signature = p256.sign(new TextEncoder().encode(data), privateScalar);
  return bytesToBase64(signature);
}

/**
 * Verify an ECDSA-P256 signature (SHA-256) against data and a public key.
 * Accepts both low-S and high-S signatures for interoperability with
 * WebCrypto-produced signatures.
 */
export async function verifySignature(
  data: string,
  signatureBase64: string,
  publicKeyBase64: string
): Promise<boolean> {
  const signature = base64ToBytes(signatureBase64);
  const publicKey = base64ToBytes(publicKeyBase64);
  return p256.verify(signature, new TextEncoder().encode(data), publicKey, { lowS: false });
}

/**
 * Derive the ECDH shared secret (32-byte X coordinate of the shared P-256
 * point) from our private key and the peer's public key. Used directly as the
 * AES-256 key, matching the legacy WebCrypto wire format (no KDF).
 */
export function deriveSharedSecret(privateKeyBase64: string, publicKeyBase64: string): Uint8Array {
  const privateScalar = loadPrivateScalar(privateKeyBase64);
  const publicKey = base64ToBytes(publicKeyBase64);
  const sharedPoint = p256.getSharedSecret(privateScalar, publicKey);
  // getSharedSecret returns a 33-byte compressed point (0x02/0x03 || X);
  // bytes [1, 33) are the raw X coordinate.
  return sharedPoint.slice(1, 1 + SCALAR_LENGTH);
}

/**
 * Initialize device keys (generate if not exists)
 */
export async function initializeDeviceKeys(): Promise<DeviceKeys> {
  const existingKeys = await getDeviceKeys();
  if (existingKeys) {
    return existingKeys;
  }

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
 * Get stored device keys. Legacy identity private keys stored as WebCrypto
 * PKCS8 DER are transparently normalized to a raw 32-byte scalar. If the
 * stored keys cannot be read at all, returns null so the caller regenerates.
 */
export async function getDeviceKeys(): Promise<DeviceKeys | null> {
  const identityKeyPairStr = await getSecureItem(IDENTITY_KEY_PAIR_KEY);
  const signedPreKeyStr = await getSecureItem(SIGNED_PRE_KEY_KEY);
  const preKeysStr = await getSecureItem(PRE_KEYS_KEY);
  const deviceIdStr = await getSecureItem(DEVICE_ID_KEY);
  const registrationIdStr = await getSecureItem(REGISTRATION_ID_KEY);

  if (!identityKeyPairStr || !signedPreKeyStr || !preKeysStr || !deviceIdStr || !registrationIdStr) {
    return null;
  }

  try {
    const identityKeyPair = JSON.parse(identityKeyPairStr) as { public: string; private: string };
    const signedPreKey = JSON.parse(signedPreKeyStr) as DeviceKeys['signedPreKey'];
    const preKeys = JSON.parse(preKeysStr) as DeviceKeys['preKeys'];
    const deviceId = parseInt(deviceIdStr, 10);
    const registrationId = parseInt(registrationIdStr, 10);

    // Normalize the identity private key to a raw 32-byte scalar. Existing web
    // devices stored it as base64 PKCS8 DER (WebCrypto exportKey('pkcs8')).
    const identityKeyPrivate = bytesToBase64(loadPrivateScalar(identityKeyPair.private));

    return {
      deviceId,
      identityKeyPublic: identityKeyPair.public,
      identityKeyPrivate,
      signedPreKey,
      preKeys,
      registrationId,
    };
  } catch (error) {
    // The stored identity key is neither a raw scalar nor parseable PKCS8 DER
    // (or the bundle is corrupt). Signal the caller to regenerate a fresh
    // identity — an acceptable clean cut for unrecoverable key material.
    // Log only the error class name — never the raw error/message, which for a
    // JSON.parse SyntaxError can embed a slice of the offending key material.
    console.warn('[SignalProtocol] migrating legacy key: stored device keys unreadable, regenerating', (error as Error)?.name);
    return null;
  }
}

/**
 * Encrypt a message for a recipient using ECDH (P-256) + AES-256-GCM.
 * Output is base64(`IV(12) || ciphertext || tag(16)`).
 */
export async function encryptMessage(
  message: string,
  recipientPublicKey: string
): Promise<string> {
  const ourKeys = await getDeviceKeys();
  if (!ourKeys) {
    throw new Error('Device keys not initialized');
  }

  const sharedSecret = deriveSharedSecret(ourKeys.identityKeyPrivate, recipientPublicKey);
  const iv = randomBytes(IV_LENGTH);
  const sealed = gcm(sharedSecret, iv).encrypt(new TextEncoder().encode(message));

  const combined = new Uint8Array(iv.length + sealed.length);
  combined.set(iv, 0);
  combined.set(sealed, iv.length);

  return bytesToBase64(combined);
}

/**
 * Decrypt a message from a sender (inverse of {@link encryptMessage}).
 */
export async function decryptMessage(
  ciphertext: string,
  senderPublicKey: string
): Promise<string> {
  const ourKeys = await getDeviceKeys();
  if (!ourKeys) {
    throw new Error('Device keys not initialized');
  }

  const sharedSecret = deriveSharedSecret(ourKeys.identityKeyPrivate, senderPublicKey);
  const combined = base64ToBytes(ciphertext);
  if (combined.length < IV_LENGTH + GCM_TAG_LENGTH) {
    throw new Error('Ciphertext is too short to contain an IV and authentication tag');
  }

  const iv = combined.slice(0, IV_LENGTH);
  const sealed = combined.slice(IV_LENGTH);
  const plaintext = gcm(sharedSecret, iv).decrypt(sealed);

  return new TextDecoder().decode(plaintext);
}
