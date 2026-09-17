/**
 * `SecretStore` over IndexedDB, for the web — and the platform's documented
 * weak point, stated here so nobody discovers it later.
 *
 * A browser has no Keychain. The storage key and the instance signing key are
 * kept in an IndexedDB store named `secrets`, in a database of their own, and
 * **any script running on this origin can read them**. That is the whole
 * limitation: an XSS on allo.you is a signing key, not just a session. It is
 * still strictly better than the alternatives — `localStorage` is readable the
 * same way AND synchronous AND string-only, and a value derived from a
 * password would need a password Allo does not have — and it is the same
 * trade every web messenger makes.
 *
 * What it buys: the SQLite/IndexedDB values are ciphertext, so a copy of the
 * `kv` store alone is nothing, and clearing site data revokes the device (the
 * signing key is gone, the server's copy of the public half is orphaned, and
 * `AlloRoot` re-enrols from scratch).
 *
 * Not `localStorage`, not AsyncStorage, not a cookie.
 */
import type { SecretStore } from '@allo/core';

export const DATABASE_NAME = 'allo-secrets';
export const STORE_NAME = 'secrets';
const DATABASE_VERSION = 1;

function awaitRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB could not be opened'));
    request.onblocked = () => reject(new Error('IndexedDB open was blocked by another tab'));
  });
}

export class IndexedDbSecrets implements SecretStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (!this.db) this.db = openDatabase();
    return this.db;
  }

  async get(name: string): Promise<Uint8Array | undefined> {
    const db = await this.open();
    const value = await awaitRequest(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(name));
    if (value === undefined) return undefined;
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    throw new Error('the secret store returned a value that is not bytes');
  }

  async set(name: string, value: Uint8Array): Promise<void> {
    const db = await this.open();
    await awaitRequest(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(new Uint8Array(value), name));
  }

  async delete(name: string): Promise<void> {
    const db = await this.open();
    await awaitRequest(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(name));
  }
}

export function createSecrets(): SecretStore {
  return new IndexedDbSecrets();
}
