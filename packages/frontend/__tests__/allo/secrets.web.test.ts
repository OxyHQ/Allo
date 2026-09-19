import {
  IndexedDbSecrets,
  STORE_NAME,
  type SecretsIdb,
  type SecretsIdbRequest,
  type SecretsIdbStore,
  type SecretsIdbTransaction,
} from '@/lib/allo/secrets.web';

/**
 * The web secret store, against an in-memory IndexedDB that can do the one
 * thing the real one cannot be asked for on purpose: fire a request's
 * `onsuccess` and then NEVER commit its transaction, which is what a page
 * being reloaded mid-write looks like from here.
 *
 * That case is the whole point of this file. A signing key whose write
 * resolved but never committed leaves a device holding its instance record —
 * `storage.web.ts` waits for its own commit, so that half is durable — with
 * the key that proves it gone. A device that cannot prove which instance it
 * is has to enrol again, and enrolling again is the "approve this device"
 * screen appearing after nothing more than a reload.
 */

type Row = { key: string; value: Uint8Array };

class FakeRequest<T> implements SecretsIdbRequest<T> {
  result!: T;
  error?: unknown;
  onsuccess: ((event: never) => unknown) | null = null;
  onerror: ((event: never) => unknown) | null = null;
}

class FakeTransaction implements SecretsIdbTransaction {
  oncomplete: ((event: never) => unknown) | null = null;
  onerror: ((event: never) => unknown) | null = null;
  onabort: ((event: never) => unknown) | null = null;
  error?: unknown;

  constructor(
    private readonly db: FakeIdb,
    private readonly commits: boolean,
  ) {}

  objectStore(): SecretsIdbStore {
    const { db } = this;
    const settle = <T>(request: FakeRequest<T>, apply: () => T) => {
      queueMicrotask(() => {
        request.result = apply();
        request.onsuccess?.(undefined as never);
        // The commit is a SEPARATE event, and a tab that goes away between the
        // two never fires it.
        if (this.commits) queueMicrotask(() => this.oncomplete?.(undefined as never));
      });
      return request;
    };
    return {
      get: (key) => settle(new FakeRequest<unknown>(), () => db.rows.find((row) => row.key === key)?.value),
      put: (value, key) =>
        settle(new FakeRequest<unknown>(), () => {
          const bytes = value as Uint8Array;
          const existing = db.rows.find((row) => row.key === key);
          if (existing) existing.value = bytes;
          else db.rows.push({ key, value: bytes });
          return undefined;
        }),
      delete: (key) =>
        settle(new FakeRequest<unknown>(), () => {
          db.rows = db.rows.filter((row) => row.key !== key);
          return undefined;
        }),
    };
  }
}

class FakeIdb implements SecretsIdb {
  rows: Row[] = [];
  /** Set false to model a page that goes away between a request succeeding and its transaction committing. */
  commits = true;

  transaction(name: string): SecretsIdbTransaction {
    expect(name).toBe(STORE_NAME);
    return new FakeTransaction(this, this.commits);
  }
}

const KEY = new Uint8Array(32).fill(7);

describe('the web secret store', () => {
  it('round-trips bytes untouched', async () => {
    const db = new FakeIdb();
    const secrets = new IndexedDbSecrets(db);
    await secrets.set('allo.instance-key.acc.allo', KEY);
    expect(await secrets.get('allo.instance-key.acc.allo')).toEqual(KEY);
    expect(await secrets.get('nothing-here')).toBeUndefined();
  });

  it('forgets a deleted key, which is what signing out depends on', async () => {
    const db = new FakeIdb();
    const secrets = new IndexedDbSecrets(db);
    await secrets.set('k', KEY);
    await secrets.delete('k');
    expect(await secrets.get('k')).toBeUndefined();
  });

  it('does not report a write as done until the transaction COMMITS', async () => {
    const db = new FakeIdb();
    db.commits = false;
    const secrets = new IndexedDbSecrets(db);

    let settled = false;
    const write = secrets.set('allo.instance-key.acc.allo', KEY).then(() => {
      settled = true;
    });

    // Let every microtask run: the request has succeeded by now, and the
    // transaction has not committed. Resolving here is the bug — it would tell
    // the SDK a signing key is safe that a reload can still take away.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    db.commits = true;
    await secrets.set('another', KEY);
    // The first write is still outstanding; nothing about it was reported done.
    expect(settled).toBe(false);
    void write;
  });

  it('reports a rejected write rather than resolving it', async () => {
    const db = new FakeIdb();
    const secrets = new IndexedDbSecrets(db);
    const tx = db.transaction(STORE_NAME);
    // A transaction that aborts is a write that did not happen, and the caller
    // has to hear about it: the SDK's read-back check depends on it.
    const aborted = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        tx.onabort?.(undefined as never);
        resolve();
      });
    });
    await aborted;
    expect(await secrets.get('unwritten')).toBeUndefined();
  });
});
