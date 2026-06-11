/**
 * Cryptographic primitives for the Signal Protocol implementation.
 *
 * Uses @noble (v2) packages:
 *  - X25519 (Diffie-Hellman) and Ed25519 (signatures) from @noble/curves/ed25519
 *  - HKDF-SHA256 from @noble/hashes
 *  - ChaCha20-Poly1305 AEAD from @noble/ciphers
 *
 * All public keys / private keys are handled as raw Uint8Array internally and
 * serialized to base64 for storage / transport.
 */

import { x25519, ed25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes, concatBytes } from '@noble/hashes/utils.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

export interface KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/** Generate an X25519 (Diffie-Hellman) key pair. */
export function generateX25519KeyPair(): KeyPair {
  const privateKey = x25519.utils.randomSecretKey();
  const publicKey = x25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/** Generate an Ed25519 (signature) key pair. */
export function generateEd25519KeyPair(): KeyPair {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  return { publicKey, privateKey };
}

/** X25519 Diffie-Hellman: returns the shared secret between our private key and a peer public key. */
export function dh(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(privateKey, publicKey);
}

/** Sign a message with an Ed25519 private key. */
export function sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return ed25519.sign(message, privateKey);
}

/** Verify an Ed25519 signature. */
export function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): boolean {
  try {
    return ed25519.verify(signature, message, publicKey);
  } catch {
    return false;
  }
}

/**
 * HKDF-SHA256 derivation.
 */
export function hkdfDerive(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number
): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

/** HMAC-style chain key derivation primitive used by the symmetric ratchet, via HKDF. */
export function deriveChainStep(input: Uint8Array, info: Uint8Array): Uint8Array {
  // 32-byte salt of zeros keeps the construction deterministic for chain stepping.
  return hkdf(sha256, input, new Uint8Array(32), info, 32);
}

/** Random bytes helper. */
export function random(length: number): Uint8Array {
  return randomBytes(length);
}

export { concatBytes };

/** AEAD ChaCha20-Poly1305 encryption. Returns nonce(24) || ciphertext (xchacha would be 24, chacha is 12). */
const NONCE_LEN = 12;

export function aeadEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array
): Uint8Array {
  const nonce = randomBytes(NONCE_LEN);
  const cipher = chacha20poly1305(key, nonce, associatedData);
  const ct = cipher.encrypt(plaintext);
  return concatBytes(nonce, ct);
}

export function aeadDecrypt(
  key: Uint8Array,
  data: Uint8Array,
  associatedData: Uint8Array
): Uint8Array {
  const nonce = data.subarray(0, NONCE_LEN);
  const ct = data.subarray(NONCE_LEN);
  const cipher = chacha20poly1305(key, nonce, associatedData);
  return cipher.decrypt(ct);
}

// ---------------------------------------------------------------------------
// Encoding helpers (base64 <-> bytes) and UTF-8 helpers.
// ---------------------------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[]
    );
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function utf8ToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
