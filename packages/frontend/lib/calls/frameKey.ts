/** Native RNKeyProvider defaults to PBKDF2 even for Uint8Array input. Use the
 * same ASCII passphrase on both public APIs; never mix native PBKDF2 and web
 * HKDF. This encodes 256 random bits and does not derive another secret. */
export function frameKeyPassphrase(key: Uint8Array): string {
  if (key.length !== 32) throw new Error('a call sender key must contain 32 bytes');
  return Array.from(key, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
