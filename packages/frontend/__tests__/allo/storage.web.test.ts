import { IndexedDbStorage, prefixRange, type KvIdb, type KvIdbRequest, type KvIdbStore, type KvIdbTransaction } from '@/lib/allo/storage.web';

/**
 * The IndexedDB adapter, against an in-memory IndexedDB that implements the
 * subset it uses: `transaction`, `objectStore`, `get`/`put`/`delete`/`getAllKeys`
 * with request events, and transaction completion. `fake-indexeddb` is not a
 * dependency, and the shim is small enough that it is clearer as a fixture —
 * and it can do one thing the real thing cannot be asked to: ABORT a batch
 * half-way through, to prove the adapter never observes a partial one.
 *
 * Two things carry the adapter: that `batch` is one transaction (atomicity),
 * and that `list(prefix)` is a key-range scan whose bounds are right at the
 * edges — a prefix that is itself a stored key, and a key that shares only a
 * shorter prefix.
 */

type Row = { key: string; value: Uint8Array };

class FakeRequest<T> implements KvIdbRequest<T> {
  result!: T;
  error?: unknown;
  onsuccess: ((ev: never) => unknown) | null = null;
  onerror: ((ev: never) => unknown) | null = null;
}

class FakeTransaction implements KvIdbTransaction {
  oncomplete: ((ev: never) => unknown) | null = null;
  onerror: ((ev: never) => unknown) | null = null;
  onabort: ((ev: never) => unknown) | null = null;
  error?: unknown;
  private pending = 0;
  private aborted = false;
  /** The rows as they were when the transaction opened: what survives an abort. */
  private readonly snapshot: Map<string, Uint8Array>;

  constructor(
    private readonly db: FakeIdb,
    private readonly mode: 'readonly' | 'readwrite',
  ) {
    this.snapshot = new Map(db.rows);
  }

  objectStore(): KvIdbStore {
    const tx = this;
    const request = <T>(work: () => T): FakeRequest<T> => {
      const req = new FakeRequest<T>();
      tx.pending += 1;
      // Requests complete asynchronously, after the caller has attached handlers.
      queueMicrotask(() => {
        if (tx.aborted) return;
        try {
          if (tx.db.failOnKey !== null && (work as { key?: string }).key === tx.db.failOnKey) throw new Error('disk full');
          req.result = work();
          req.onsuccess?.(undefined as never);
        } catch (error) {
          req.error = error;
          tx.abort(error);
          req.onerror?.(undefined as never);
          return;
        }
        tx.pending -= 1;
        if (tx.pending === 0) queueMicrotask(() => tx.complete());
      });
      return req;
    };
    return {
      get: (key) => request(() => (tx.db.rows.has(key) ? new Uint8Array(tx.db.rows.get(key)!) : undefined)),
      put: (value, key) => {
        if (tx.mode !== 'readwrite') throw new Error('read-only transaction');
        const work = () => {
          tx.db.rows.set(key, new Uint8Array(value as Uint8Array));
          return key;
        };
        (work as { key?: string }).key = key;
        return request(work);
      },
      delete: (key) => {
        if (tx.mode !== 'readwrite') throw new Error('read-only transaction');
        return request(() => {
          tx.db.rows.delete(key);
          return undefined;
        });
      },
      getAllKeys: (range) => {
        const { lower, upper } = range as { lower: string; upper: string };
        return request(() => [...tx.db.rows.keys()].filter((k) => k >= lower && k < upper).sort());
      },
    };
  }

  private abort(error: unknown): void {
    if (this.aborted) return;
    this.aborted = true;
    this.error = error;
    // Everything written since the transaction opened is rolled back.
    this.db.rows.clear();
    for (const [k, v] of this.snapshot) this.db.rows.set(k, v);
    queueMicrotask(() => this.onabort?.(undefined as never));
  }

  private complete(): void {
    if (this.aborted) return;
    this.oncomplete?.(undefined as never);
  }
}

class FakeIdb implements KvIdb {
  readonly rows = new Map<string, Uint8Array>();
  /** A key whose `put` fails, to abort a transaction mid-batch. */
  failOnKey: string | null = null;
  transactions = 0;

  transaction(_store: string, mode: 'readonly' | 'readwrite'): KvIdbTransaction {
    this.transactions += 1;
    return new FakeTransaction(this, mode);
  }
}

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

function storage(): { adapter: IndexedDbStorage; idb: FakeIdb } {
  const idb = new FakeIdb();
  return { adapter: new IndexedDbStorage(idb, (lower, upper) => ({ lower, upper })), idb };
}

describe('prefixRange', () => {
  it('is [prefix, prefix + U+FFFF)', () => {
    expect(prefixRange('a/b')).toEqual({ lower: 'a/b', upper: 'a/b￿' });
  });

  it('includes the prefix itself and excludes anything past every extension of it', () => {
    const { lower, upper } = prefixRange('allo/x/');
    const inside = ['allo/x/', 'allo/x/a', 'allo/x/￾', 'allo/x/zzz/deep'];
    const outside = ['allo/x', 'allo/y/', 'allo/x0', 'allo'];
    for (const k of inside) expect(k >= lower && k < upper).toBe(true);
    for (const k of outside) expect(k >= lower && k < upper).toBe(false);
  });
});

describe('IndexedDbStorage', () => {
  it('round-trips bytes', async () => {
    const { adapter } = storage();
    await adapter.set('k', bytes('hello'));
    expect(text(await adapter.get('k'))).toBe('hello');
    expect(await adapter.get('missing')).toBeUndefined();
    await adapter.delete('k');
    expect(await adapter.get('k')).toBeUndefined();
  });

  it('lists by prefix, sorted, with exact edges', async () => {
    const { adapter } = storage();
    await adapter.batch([
      { type: 'set', key: 'allo/a/conversation/2', value: bytes('') },
      { type: 'set', key: 'allo/a/conversation/1', value: bytes('') },
      { type: 'set', key: 'allo/a/conversation', value: bytes('') },
      { type: 'set', key: 'allo/a/conversations-other', value: bytes('') },
      { type: 'set', key: 'allo/b/conversation/1', value: bytes('') },
    ]);
    expect(await adapter.list('allo/a/conversation/')).toEqual(['allo/a/conversation/1', 'allo/a/conversation/2']);
    // The prefix that is itself a key is included; a sibling that merely shares a shorter prefix is not.
    expect(await adapter.list('allo/a/conversation')).toEqual([
      'allo/a/conversation',
      'allo/a/conversation/1',
      'allo/a/conversation/2',
      'allo/a/conversations-other',
    ]);
    expect(await adapter.list('nothing/')).toEqual([]);
  });

  it('writes a batch in ONE transaction', async () => {
    const { adapter, idb } = storage();
    await adapter.batch([
      { type: 'set', key: 'a', value: bytes('1') },
      { type: 'set', key: 'b', value: bytes('2') },
      { type: 'delete', key: 'zzz' },
    ]);
    expect(idb.transactions).toBe(1);
    expect(text(await adapter.get('a'))).toBe('1');
    expect(text(await adapter.get('b'))).toBe('2');
  });

  it('leaves NOTHING of a batch that aborts half-way', async () => {
    // The property the sync engine is built on: a cursor and the events it
    // covers land together or not at all.
    const { adapter, idb } = storage();
    await adapter.set('cursor', bytes('before'));
    idb.failOnKey = 'event/2';
    await expect(
      adapter.batch([
        { type: 'set', key: 'event/1', value: bytes('e1') },
        { type: 'set', key: 'event/2', value: bytes('e2') },
        { type: 'set', key: 'cursor', value: bytes('after') },
      ]),
    ).rejects.toThrow(/disk full/);
    idb.failOnKey = null;
    expect(await adapter.get('event/1')).toBeUndefined();
    expect(text(await adapter.get('cursor'))).toBe('before');
  });

  it('does nothing for an empty batch', async () => {
    const { adapter, idb } = storage();
    await adapter.batch([]);
    expect(idb.transactions).toBe(0);
  });

  it('stores a copy, so a caller mutating its buffer afterwards changes nothing', async () => {
    const { adapter } = storage();
    const value = bytes('abc');
    await adapter.set('k', value);
    value[0] = 0x7a;
    expect(text(await adapter.get('k'))).toBe('abc');
  });
});
