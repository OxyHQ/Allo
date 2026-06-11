/**
 * End-to-end encryption for chat media (Fase 1D).
 *
 * Media is encrypted ONCE with a fresh random symmetric key (ChaCha20-Poly1305)
 * before upload; only the opaque ciphertext leaves the device. The symmetric key
 * is NEVER sent to the server: it rides inside the Signal-encrypted message body
 * (see `mediaPayload.ts` + `stores/messagesStore.ts`), so it is wrapped per
 * recipient device by the existing X3DH + Double Ratchet fan-out. The server only
 * ever stores ciphertext bytes and opaque envelopes — it cannot read media.
 *
 * Wire format of an encrypted blob (what is uploaded):
 *   nonce(12) || chacha20poly1305_ciphertext(plaintextLen + 16 tag)
 * The plaintext MIME and byte size are bound into the AEAD associated data so a
 * server (or attacker) cannot substitute a blob of a different type/length
 * without the authentication tag failing on decrypt.
 *
 * Crypto primitives are reused from the Signal key layer (`lib/signal/keys.ts`),
 * which wraps @noble — there is no second crypto implementation.
 */

import {
  aeadEncrypt,
  aeadDecrypt,
  random,
  bytesToBase64,
  base64ToBytes,
  utf8ToBytes,
} from '@/lib/signal/keys';

/** Length of the random media key in bytes (ChaCha20-Poly1305 key size). */
export const MEDIA_KEY_LENGTH = 32;

/** Result of encrypting a media blob, ready for upload + per-device wrapping. */
export interface EncryptedMediaBlob {
  /** Bytes to upload: `nonce(12) || ciphertext+tag`. */
  ciphertext: Uint8Array;
  /** Base64 random symmetric key — carried inside the E2E message body only. */
  keyBase64: string;
  /** Plaintext MIME type, preserved so the recipient renders the right type. */
  mime: string;
  /** Plaintext byte length, bound into the AEAD AAD and used as an integrity check. */
  size: number;
}

/**
 * Build the AEAD associated data binding the plaintext MIME and size to the
 * ciphertext. The exact same bytes must be reproduced on decrypt or the tag
 * check fails, so the format is fixed (`mime|size`, UTF-8).
 */
function buildMediaAad(mime: string, size: number): Uint8Array {
  return utf8ToBytes(`${mime}|${size}`);
}

/**
 * Encrypt a media blob with a fresh random key. The returned `ciphertext` is the
 * only thing uploaded; `keyBase64` must be transported exclusively inside the
 * E2E-encrypted message body.
 */
export function encryptMediaBlob(bytes: Uint8Array, mime: string): EncryptedMediaBlob {
  if (!mime || typeof mime !== 'string') {
    throw new Error('encryptMediaBlob: a non-empty MIME type is required');
  }
  const key = random(MEDIA_KEY_LENGTH);
  const aad = buildMediaAad(mime, bytes.length);
  // aeadEncrypt prepends the 12-byte nonce, so `ciphertext` is nonce || ct+tag.
  const ciphertext = aeadEncrypt(key, bytes, aad);
  return {
    ciphertext,
    keyBase64: bytesToBase64(key),
    mime,
    size: bytes.length,
  };
}

/** The minimal media-key material needed to decrypt a downloaded blob. */
export interface MediaDecryptionKey {
  /** Base64 symmetric key recovered from the decrypted message body. */
  keyBase64: string;
  /** Plaintext MIME type (must match what was bound at encrypt time). */
  mime: string;
  /** Plaintext byte length (must match what was bound at encrypt time). */
  size: number;
}

/**
 * Decrypt a downloaded media blob (`nonce || ciphertext+tag`) using the key,
 * MIME and size recovered from the decrypted message body. Throws if the
 * authentication tag, MIME or size do not match (wrong key, tampering, or a
 * server-side blob substitution).
 */
export function decryptMediaBlob(ciphertext: Uint8Array, key: MediaDecryptionKey): Uint8Array {
  const keyBytes = base64ToBytes(key.keyBase64);
  if (keyBytes.length !== MEDIA_KEY_LENGTH) {
    throw new Error('decryptMediaBlob: invalid media key length');
  }
  const aad = buildMediaAad(key.mime, key.size);
  // aeadDecrypt reads the 12-byte nonce prefix and verifies the Poly1305 tag.
  const plaintext = aeadDecrypt(keyBytes, ciphertext, aad);
  if (plaintext.length !== key.size) {
    // Defensive: the AAD already binds the size, so a mismatch means corruption.
    throw new Error('decryptMediaBlob: decrypted size does not match expected size');
  }
  return plaintext;
}
