/**
 * `SecretStore` over `expo-secure-store`: the iOS Keychain and the Android
 * Keystore. Two things live here, both small: the key that encrypts the SQLite
 * store at rest, and this installation's Ed25519 signing key.
 *
 * Bytes in, bytes out; the Keychain stores strings, so values cross as base64.
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps an entry out of every backup and off
 * every other device — a signing key that migrated with an iCloud restore would
 * make two devices one instance, which is exactly what the enrollment chain
 * exists to prevent.
 *
 * No fallback. `lib/secureStorage.ts` used to answer AsyncStorage when the
 * Keychain was unavailable; a signing key in AsyncStorage is a signing key in
 * a plaintext file, and this store would rather throw.
 */
import * as SecureStore from 'expo-secure-store';
import { base64Decode, base64Encode, type SecretStore } from '@allo/core';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

/** Keychain keys may only carry `[A-Za-z0-9._-]`; core's names carry the account id, which is safe, but the rule is enforced here regardless. */
export function secureStoreKey(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** The minimum of `expo-secure-store` used, so a test can hand in a fake. */
export interface SecureStoreLike {
  getItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStore.SecureStoreOptions): Promise<void>;
}

export class SecureStoreSecrets implements SecretStore {
  constructor(private readonly store: SecureStoreLike = SecureStore) {}

  async get(name: string): Promise<Uint8Array | undefined> {
    const value = await this.store.getItemAsync(secureStoreKey(name), OPTIONS);
    return value === null ? undefined : base64Decode(value);
  }

  async set(name: string, value: Uint8Array): Promise<void> {
    await this.store.setItemAsync(secureStoreKey(name), base64Encode(value), OPTIONS);
  }

  async delete(name: string): Promise<void> {
    await this.store.deleteItemAsync(secureStoreKey(name), OPTIONS);
  }
}

export function createSecrets(): SecretStore {
  return new SecureStoreSecrets();
}
