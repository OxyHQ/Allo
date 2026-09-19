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
 *
 * ## A write is not done until its TRANSACTION is done
 *
 * IndexedDB fires `onsuccess` for a request while its transaction is still
 * open, and the transaction commits later — when the task that issued it
 * finishes. Resolving on the request is therefore a lie: the page can be
 * reloaded, or the tab closed, between the two, and the write is gone.
 *
 * That asymmetry is not theoretical here. `storage.web.ts` awaits
 * `oncomplete`, so the encrypted store IS durable, and if this one resolves
 * early a reload can leave a device holding its instance RECORD with the
 * signing key that proves it missing — and a device that cannot prove which
 * instance it is has to enrol again, which is a stranger asking to be
 * approved. So every write here waits for the commit, and `delete` waits too:
 * a sign-out that appears to have wiped a key and has not is worse than one
 * that takes another millisecond.
 */
import type { SecretStore } from '@allo/core';

export const DATABASE_NAME = 'allo-secrets';
export const STORE_NAME = 'secrets';
const DATABASE_VERSION = 1;

/** What this module uses of IndexedDB, so a test can supply the subset — including one that never commits. */
export interface SecretsIdbRequest<T> {
  result: T;
  error?: unknown;
  onsuccess: ((event: never) => unknown) | null;
  onerror: ((event: never) => unknown) | null;
}

export interface SecretsIdbStore {
  get(key: string): SecretsIdbRequest<unknown>;
  put(value: unknown, key: string): SecretsIdbRequest<unknown>;
  delete(key: string): SecretsIdbRequest<unknown>;
}

export interface SecretsIdbTransaction {
  objectStore(name: string): SecretsIdbStore;
  oncomplete: ((event: never) => unknown) | null;
  onerror: ((event: never) => unknown) | null;
  onabort: ((event: never) => unknown) | null;
  error?: unknown;
}

export interface SecretsIdb {
  transaction(name: string, mode: 'readonly' | 'readwrite'): SecretsIdbTransaction;
}

function awaitRequest<T>(request: SecretsIdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when the transaction COMMITS, which is the only moment a write has survived. */
function awaitTransaction(tx: SecretsIdbTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
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
  private db: Promise<SecretsIdb> | null = null;

  constructor(private readonly database?: SecretsIdb) {}

  private open(): Promise<SecretsIdb> {
    if (this.database) return Promise.resolve(this.database);
    if (!this.db) this.db = openDatabase() as unknown as Promise<SecretsIdb>;
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
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const committed = awaitTransaction(tx);
    tx.objectStore(STORE_NAME).put(new Uint8Array(value), name);
    await committed;
  }

  async delete(name: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const committed = awaitTransaction(tx);
    tx.objectStore(STORE_NAME).delete(name);
    await committed;
  }
}

export function createSecrets(): SecretStore {
  return new IndexedDbSecrets();
}
