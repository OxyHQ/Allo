/**
 * `StorageAdapter` over IndexedDB, for the web.
 *
 * One database, one object store `kv` keyed by the string key, values as
 * `Uint8Array`. Every value is already ciphertext (see `storage.native.ts`),
 * so what an origin's script can read out of IndexedDB is nothing without the
 * storage key — and that key is the web platform's known weak point; see
 * `secrets.web.ts`.
 *
 * `batch` is one readwrite transaction: IndexedDB commits or aborts it as a
 * whole, which is the atomicity the SDK's sync tick relies on.
 *
 * `list(prefix)` is a key-range scan, `[prefix, prefix + U+FFFF)`, which is
 * how IndexedDB spells "starts with": keys are compared as strings, and no
 * key that starts with `prefix` sorts at or after `prefix + U+FFFF`. No
 * escaping is needed — there are no wildcards in a key range — and the pure
 * arithmetic of the bound is `prefixRange`, tested on its own.
 *
 * Nothing here may fall back to `localStorage` or AsyncStorage.
 */
import type { StorageAdapter, StorageOp } from '@allo/core';

export const DATABASE_NAME = 'allo';
export const STORE_NAME = 'kv';
const DATABASE_VERSION = 1;

/** The `[lower, upper)` bounds of every key that starts with `prefix`. */
export function prefixRange(prefix: string): { lower: string; upper: string } {
  return { lower: prefix, upper: `${prefix}\uffff` };
}

/** The minimum of an `IDBDatabase` this adapter uses, so a test can hand in a fake. */
export interface KvIdb {
  transaction(storeName: string, mode: 'readonly' | 'readwrite'): KvIdbTransaction;
}

/** A DOM event handler slot, typed so both the real `IDBRequest` and a test fake fit. */
type Handler = ((ev: never) => unknown) | null;

export interface KvIdbTransaction {
  objectStore(name: string): KvIdbStore;
  oncomplete: Handler;
  onerror: Handler;
  onabort: Handler;
  error?: unknown;
}

export interface KvIdbRequest<T> {
  result: T;
  error?: unknown;
  onsuccess: Handler;
  onerror: Handler;
}

export interface KvIdbStore {
  get(key: string): KvIdbRequest<unknown>;
  put(value: unknown, key: string): KvIdbRequest<unknown>;
  delete(key: string): KvIdbRequest<unknown>;
  getAllKeys(range: unknown): KvIdbRequest<unknown[]>;
}

/** Builds the key range the platform understands. Overridable so a fake store can accept a plain object. */
export type RangeFactory = (lower: string, upper: string) => unknown;

const defaultRangeFactory: RangeFactory = (lower, upper) => IDBKeyRange.bound(lower, upper, false, true);

function awaitRequest<T>(request: KvIdbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function awaitTransaction(tx: KvIdbTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export class IndexedDbStorage implements StorageAdapter {
  constructor(
    private readonly db: KvIdb,
    private readonly range: RangeFactory = defaultRangeFactory,
  ) {}

  async get(key: string): Promise<Uint8Array | undefined> {
    const tx = this.db.transaction(STORE_NAME, 'readonly');
    const value = await awaitRequest(tx.objectStore(STORE_NAME).get(key));
    return value === undefined ? undefined : toBytes(value);
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await this.batch([{ type: 'set', key, value }]);
  }

  async delete(key: string): Promise<void> {
    await this.batch([{ type: 'delete', key }]);
  }

  async list(prefix: string): Promise<string[]> {
    const { lower, upper } = prefixRange(prefix);
    const tx = this.db.transaction(STORE_NAME, 'readonly');
    const keys = await awaitRequest(tx.objectStore(STORE_NAME).getAllKeys(this.range(lower, upper)));
    return keys.map(String).sort();
  }

  async batch(ops: StorageOp[]): Promise<void> {
    if (ops.length === 0) return;
    const tx = this.db.transaction(STORE_NAME, 'readwrite');
    const done = awaitTransaction(tx);
    const store = tx.objectStore(STORE_NAME);
    for (const op of ops) {
      // Requests are issued without awaiting each one: the transaction stays
      // open only while requests are pending, and an `await` between them on
      // some browsers lets it auto-commit early, splitting the batch.
      if (op.type === 'set') store.put(new Uint8Array(op.value), op.key);
      else store.delete(op.key);
    }
    await done;
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error('IndexedDB returned a value that is not bytes');
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

let opening: Promise<IndexedDbStorage> | null = null;

/** The app's one storage adapter. Opened once; every client shares the database and is namespaced by core. */
export function createStorage(): Promise<StorageAdapter> {
  if (!opening) opening = openDatabase().then((db) => new IndexedDbStorage(db));
  return opening;
}
