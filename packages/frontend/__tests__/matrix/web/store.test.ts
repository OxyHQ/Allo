import { MatrixPortError, MatrixStoreNotErasedError } from '@/lib/matrix/errors';
import {
  cryptoDatabasePrefix,
  eraseWebStore,
  resolveAlloChatStore,
  syncDatabaseName,
} from '@/lib/matrix/store.web';
import type { AlloClientStore } from '@/lib/matrix/types';

/**
 * Where the web client keeps its data, and what erasing it has to reach.
 *
 * The names are the whole subject. `clearStores` and `initRustCrypto` are given
 * a prefix each and neither one checks the other's: given the wrong name the SDK
 * deletes nothing, reports success, and leaves a device's encryption keys in the
 * browser. So the names are built in one place and asserted here against the
 * strings the SDK actually derives from them.
 */

const STORE: AlloClientStore = {
  kind: 'filesystem',
  dataPath: 'allo-matrix',
  cachePath: 'allo-matrix',
};

/** An `IDBFactory` that records deletions instead of performing them. */
class FakeIndexedDB {
  readonly deleted: string[] = [];
  readonly present: string[] = [];
  /** Databases that answer with an error, as a private window's do. */
  refuse = new Set<string>();
  /** Whether this browser offers `databases()` at all. */
  listable = true;

  deleteDatabase(name: string): IDBOpenDBRequest {
    const request: Record<string, unknown> = { error: new Error('refused') };
    queueMicrotask(() => {
      if (this.refuse.has(name)) {
        callHandler(request.onerror);
        return;
      }
      this.deleted.push(name);
      callHandler(request.onsuccess);
    });
    return request as unknown as IDBOpenDBRequest;
  }

  databases(): Promise<IDBDatabaseInfo[]> {
    return Promise.resolve(this.present.map((name) => ({ name, version: 1 })));
  }

  /** The shape of a browser without `databases()`. */
  factory(): IDBFactory {
    const self: Record<string, unknown> = {
      deleteDatabase: (name: string) => this.deleteDatabase(name),
    };
    if (this.listable) {
      self.databases = () => this.databases();
    }
    return self as unknown as IDBFactory;
  }
}

function callHandler(handler: unknown): void {
  if (typeof handler === 'function') {
    handler(new Event('done'));
  }
}

describe('the web store’s names', () => {
  it('names the same database matrix-js-sdk will', () => {
    // The SDK puts `matrix-js-sdk:` in front of the name it is given, and the
    // eraser has to name the database rather than the store.
    expect(syncDatabaseName('allo-matrix')).toBe('matrix-js-sdk:allo-matrix');
  });

  it('keys the crypto databases by device', () => {
    // A crypto store belongs to exactly one device. A fresh install that
    // inherited the last one would hold keys for an identity the homeserver has
    // never heard of.
    expect(cryptoDatabasePrefix('allo-matrix', 'DEVICE1')).toBe('allo-matrix:DEVICE1');
    expect(cryptoDatabasePrefix('allo-matrix', 'DEVICE2')).not.toBe(
      cryptoDatabasePrefix('allo-matrix', 'DEVICE1'),
    );
  });

  it('resolves a store on disk, not one in memory', () => {
    // A store in memory throws the device identity away when the tab closes,
    // which is the every-launch-is-a-new-device behaviour this replaced.
    expect(resolveAlloChatStore().kind).toBe('filesystem');
  });
});

describe('eraseWebStore', () => {
  it('deletes the synced state, which is the one a new session would inherit', async () => {
    const indexedDB = new FakeIndexedDB();

    await eraseWebStore(STORE, indexedDB.factory());

    expect(indexedDB.deleted).toContain('matrix-js-sdk:allo-matrix');
  });

  it('deletes the crypto databases of every device that left one', async () => {
    // Not correctness — a crypto database is named after its device and cannot
    // be opened by the session that comes next — but storage that would
    // otherwise never be reclaimed.
    const indexedDB = new FakeIndexedDB();
    indexedDB.present.push(
      'allo-matrix:DEVICE1::matrix-sdk-crypto',
      'allo-matrix:DEVICE1::matrix-sdk-crypto-meta',
      'allo-matrix:DEVICE2::matrix-sdk-crypto',
    );

    await eraseWebStore(STORE, indexedDB.factory());

    expect(indexedDB.deleted).toEqual(
      expect.arrayContaining([
        'allo-matrix:DEVICE1::matrix-sdk-crypto',
        'allo-matrix:DEVICE1::matrix-sdk-crypto-meta',
        'allo-matrix:DEVICE2::matrix-sdk-crypto',
      ]),
    );
  });

  it('leaves databases that are not this store’s alone', async () => {
    const indexedDB = new FakeIndexedDB();
    indexedDB.present.push(
      'someone-else:DEVICE1::matrix-sdk-crypto',
      'allo-matrix:DEVICE1::something-else',
      'matrix-js-sdk:another-store',
    );

    await eraseWebStore(STORE, indexedDB.factory());

    expect(indexedDB.deleted).toEqual(['matrix-js-sdk:allo-matrix']);
  });

  it('still deletes the synced state in a browser with no databases()', async () => {
    // Firefox before 126. The leftovers cannot be found, which costs storage —
    // the one that matters for correctness is named without asking the browser
    // anything.
    const indexedDB = new FakeIndexedDB();
    indexedDB.listable = false;
    indexedDB.present.push('allo-matrix:DEVICE1::matrix-sdk-crypto');

    await eraseWebStore(STORE, indexedDB.factory());

    expect(indexedDB.deleted).toEqual(['matrix-js-sdk:allo-matrix']);
  });

  it('carries on past a database it is refused, and then refuses to report success', async () => {
    // Two halves of one rule, and they only make sense together.
    //
    // It carries on, because stopping at the first refusal would leave behind
    // databases that could have gone.
    //
    // And it throws, because this is how one account's synced state and keys are
    // kept away from the next one. Resolving here — which is what this used to do
    // — told `matrixRuntime` the store was empty, and the runtime opened it and
    // put the next identity in it. A private window whose `indexedDB` refuses
    // every mutation now ends at an explanation instead.
    const indexedDB = new FakeIndexedDB();
    indexedDB.present.push('allo-matrix:DEVICE1::matrix-sdk-crypto');
    indexedDB.refuse.add('matrix-js-sdk:allo-matrix');

    await expect(eraseWebStore(STORE, indexedDB.factory())).rejects.toThrow(
      MatrixStoreNotErasedError,
    );

    expect(indexedDB.deleted).toEqual(['allo-matrix:DEVICE1::matrix-sdk-crypto']);
  });

  it('names what is still there, so the failure says which piece', async () => {
    const indexedDB = new FakeIndexedDB();
    indexedDB.present.push(
      'allo-matrix:DEVICE1::matrix-sdk-crypto',
      'allo-matrix:DEVICE2::matrix-sdk-crypto',
    );
    indexedDB.refuse.add('allo-matrix:DEVICE1::matrix-sdk-crypto');
    indexedDB.refuse.add('allo-matrix:DEVICE2::matrix-sdk-crypto');

    const failure = await eraseWebStore(STORE, indexedDB.factory()).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(MatrixStoreNotErasedError);
    expect((failure as MatrixStoreNotErasedError).names).toEqual([
      'allo-matrix:DEVICE1::matrix-sdk-crypto',
      'allo-matrix:DEVICE2::matrix-sdk-crypto',
    ]);
  });

  it('does nothing for a store that was never on disk', async () => {
    const indexedDB = new FakeIndexedDB();

    await eraseWebStore({ kind: 'in-memory' }, indexedDB.factory());

    expect(indexedDB.deleted).toEqual([]);
  });

  it('refuses a browser with no IndexedDB rather than reporting an erased store', async () => {
    // Reporting success would let the client open a store this could not have
    // cleared.
    await expect(eraseWebStore(STORE, undefined)).rejects.toThrow(MatrixPortError);
  });
});
