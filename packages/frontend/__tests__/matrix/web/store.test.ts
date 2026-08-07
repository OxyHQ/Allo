import {
  MatrixPortError,
  MatrixStoreEraseBlockedError,
  MatrixStoreNotErasedError,
} from '@/lib/matrix/errors';
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
  /**
   * Databases another connection still has open.
   *
   * The browser answers `onblocked` and then nothing at all: the request stays
   * pending until that connection closes, which is what {@link release} is. A
   * name left in here is a second window of Allo that nobody ever closes.
   */
  block = new Set<string>();
  /** Whether this browser offers `databases()` at all. */
  listable = true;

  /** Every deletion this factory has handed out, by name. */
  readonly #requests = new Map<string, Record<string, unknown>>();

  deleteDatabase(name: string): IDBOpenDBRequest {
    const request: Record<string, unknown> = { error: new Error('refused') };
    this.#requests.set(name, request);
    queueMicrotask(() => {
      if (this.refuse.has(name)) {
        callHandler(request.onerror);
        return;
      }
      if (this.block.has(name)) {
        callHandler(request.onblocked);
        return;
      }
      this.deleted.push(name);
      callHandler(request.onsuccess);
    });
    return request as unknown as IDBOpenDBRequest;
  }

  /** The other connection closes: the pending deletion completes on its own. */
  release(name: string): void {
    this.block.delete(name);
    this.deleted.push(name);
    callHandler(this.#request(name).onsuccess);
  }

  /**
   * The browser reports `onblocked` again on a request it has already answered.
   *
   * Allowed by the specification — "the implementation may fire it more than
   * once" — and the reason the deletion keeps a `settled` of its own rather than
   * relying on the promise's, which is idempotent and would swallow it silently.
   */
  blockAgain(name: string): void {
    callHandler(this.#request(name).onblocked);
  }

  #request(name: string): Record<string, unknown> {
    const request = this.#requests.get(name);
    if (request === undefined) {
      throw new Error(`${name} was never asked to be deleted`);
    }
    return request;
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

  it('says nothing about waiting when nothing is in the way', async () => {
    // The ordinary launch. A report here would put "Allo is open in another tab"
    // in front of somebody for whom it is not true.
    const indexedDB = new FakeIndexedDB();
    const reports: boolean[] = [];

    await eraseWebStore(STORE, indexedDB.factory(), {
      onBlocked: (blocked) => reports.push(blocked),
    });

    expect(reports).toEqual([]);
  });
});

/**
 * A DELETION ANOTHER WINDOW IS HOLDING UP.
 *
 * The state the owner met in production: the crypto database was open in a
 * second tab, IndexedDB left the deletion pending, and the launch waited behind
 * it with nothing on screen but "Connecting…". Waiting was right — it is the
 * only answer that does not open somebody else's keys, and it ends by itself —
 * but waiting in silence, with no bound, is a hang.
 *
 * So there are three things to keep true here, and each of them is a case: the
 * wait is announced, it ends by itself when the other window goes, and it is
 * bounded. What must never be true is the fourth: that giving up resolves. A
 * resolution is read by `matrixRuntime` as "the store is empty" and is followed
 * immediately by opening it.
 */
describe('eraseWebStore, blocked by another connection', () => {
  /**
   * Short enough that the bound is reached inside a test, not a coffee break.
   *
   * Every case that reaches it also waits {@link reachTheBlock} first, which
   * costs a macrotask; the gap between the two is what keeps the ordering
   * deterministic without fake timers.
   */
  const BOUND_MS = 60;

  /** Lets the deletion start and the browser answer `onblocked`. */
  const reachTheBlock = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  it('reports the wait as soon as the browser reports it', async () => {
    const indexedDB = new FakeIndexedDB();
    indexedDB.block.add('matrix-js-sdk:allo-matrix');
    const reports: boolean[] = [];

    const erasing = eraseWebStore(STORE, indexedDB.factory(), {
      onBlocked: (blocked) => reports.push(blocked),
      blockedTimeoutMs: BOUND_MS,
    }).catch(() => undefined);
    // Long enough for the browser to answer `onblocked`, far short of the bound.
    // What is being asserted is that the report does not wait for the outcome —
    // one that only arrived at the end would be a screen that only appeared once
    // there was nothing left to say.
    await reachTheBlock();

    expect(reports).toEqual([true]);

    await erasing;
  });

  it('finishes on its own when the other window closes, and says the wait is over', async () => {
    // The common ending, and the one that must not need a reload: the pending
    // request completes the moment the other connection goes, so the erase
    // resolves and the launch carries on from where it was.
    const indexedDB = new FakeIndexedDB();
    indexedDB.block.add('matrix-js-sdk:allo-matrix');
    const reports: boolean[] = [];

    const erasing = eraseWebStore(STORE, indexedDB.factory(), {
      onBlocked: (blocked) => reports.push(blocked),
      blockedTimeoutMs: BOUND_MS,
    });
    await reachTheBlock();
    indexedDB.release('matrix-js-sdk:allo-matrix');

    await expect(erasing).resolves.toBeUndefined();
    expect(reports).toEqual([true, false]);
    expect(indexedDB.deleted).toEqual(['matrix-js-sdk:allo-matrix']);
  });

  it('gives up at the bound, and gives up by throwing', async () => {
    // THE ONE THAT MATTERS. Resolving here would tell the runtime the store was
    // empty and the runtime would open it — which is a client reading the last
    // account's synced state, out of a database this could not delete.
    const indexedDB = new FakeIndexedDB();
    indexedDB.block.add('matrix-js-sdk:allo-matrix');

    const failure = await eraseWebStore(STORE, indexedDB.factory(), {
      blockedTimeoutMs: BOUND_MS,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MatrixStoreEraseBlockedError);
    expect((failure as MatrixStoreEraseBlockedError).names).toEqual([
      'matrix-js-sdk:allo-matrix',
    ]);
    expect((failure as MatrixStoreEraseBlockedError).waitedMs).toBe(BOUND_MS);
    expect(indexedDB.deleted).toEqual([]);
  });

  it('is not a MatrixStoreNotErasedError, because the reader can fix one of them', async () => {
    // A refused store cannot be deleted at all; a blocked one deletes itself the
    // moment a window closes. The screens differ, so the types have to.
    const indexedDB = new FakeIndexedDB();
    indexedDB.block.add('matrix-js-sdk:allo-matrix');

    const failure = await eraseWebStore(STORE, indexedDB.factory(), {
      blockedTimeoutMs: BOUND_MS,
    }).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(MatrixStoreNotErasedError);
  });

  it('does not report the wait as over when it is giving up', async () => {
    // The screen would flick back to a spinner for one tick and then stop on a
    // failure. Worse than either state on its own.
    const indexedDB = new FakeIndexedDB();
    indexedDB.block.add('matrix-js-sdk:allo-matrix');
    const reports: boolean[] = [];

    await eraseWebStore(STORE, indexedDB.factory(), {
      onBlocked: (blocked) => reports.push(blocked),
      blockedTimeoutMs: BOUND_MS,
    }).catch(() => undefined);

    expect(reports).toEqual([true]);
  });

  it('says nothing more once it has given up, however late the browser answers', async () => {
    // IndexedDB has no way to cancel a deletion, so the request outlives the
    // failure and may complete minutes later. It still deletes the database,
    // which is what the next attempt wants — but it must not report to a caller
    // that has already stopped.
    const indexedDB = new FakeIndexedDB();
    indexedDB.block.add('matrix-js-sdk:allo-matrix');
    const reports: boolean[] = [];

    await eraseWebStore(STORE, indexedDB.factory(), {
      onBlocked: (blocked) => reports.push(blocked),
      blockedTimeoutMs: BOUND_MS,
    }).catch(() => undefined);
    indexedDB.release('matrix-js-sdk:allo-matrix');
    await reachTheBlock();

    expect(reports).toEqual([true]);
  });

  it('does not announce a second wait after it has given up on the first', async () => {
    // A browser is allowed to fire `onblocked` again, and one arriving after the
    // bound would announce a wait nobody is waiting through — the screen would
    // go back to "another window has your data" over a launch that has already
    // stopped — and would arm a timer with nothing left to reject.
    const indexedDB = new FakeIndexedDB();
    indexedDB.block.add('matrix-js-sdk:allo-matrix');
    const reports: boolean[] = [];

    await eraseWebStore(STORE, indexedDB.factory(), {
      onBlocked: (blocked) => reports.push(blocked),
      blockedTimeoutMs: BOUND_MS,
    }).catch(() => undefined);
    indexedDB.blockAgain('matrix-js-sdk:allo-matrix');

    expect(reports).toEqual([true]);
  });

  it('does not announce a wait on a deletion that has already finished', async () => {
    // The same guard from the other side: the deletion succeeded, the erase
    // resolved, and a stray report here would reach a runtime that has moved on
    // to building a client.
    const indexedDB = new FakeIndexedDB();
    const reports: boolean[] = [];

    await eraseWebStore(STORE, indexedDB.factory(), {
      onBlocked: (blocked) => reports.push(blocked),
      blockedTimeoutMs: BOUND_MS,
    });
    indexedDB.blockAgain('matrix-js-sdk:allo-matrix');

    expect(reports).toEqual([]);
  });

  it('announces the wait once when the browser reports it twice', async () => {
    const indexedDB = new FakeIndexedDB();
    indexedDB.block.add('matrix-js-sdk:allo-matrix');
    const reports: boolean[] = [];

    const erasing = eraseWebStore(STORE, indexedDB.factory(), {
      onBlocked: (blocked) => reports.push(blocked),
      blockedTimeoutMs: BOUND_MS,
    });
    await reachTheBlock();
    indexedDB.blockAgain('matrix-js-sdk:allo-matrix');
    indexedDB.release('matrix-js-sdk:allo-matrix');

    await expect(erasing).resolves.toBeUndefined();
    expect(reports).toEqual([true, false]);
  });

  it('stops rather than waiting out every database in turn', async () => {
    // Collecting blocks the way refusals are collected would multiply the bound
    // by the number of databases, and the reader would be looking at a screen
    // that cannot change for minutes. One window is holding all of them anyway.
    const indexedDB = new FakeIndexedDB();
    indexedDB.present.push('allo-matrix:DEVICE1::matrix-sdk-crypto');
    indexedDB.block.add('matrix-js-sdk:allo-matrix');

    await eraseWebStore(STORE, indexedDB.factory(), { blockedTimeoutMs: BOUND_MS }).catch(
      () => undefined,
    );

    expect(indexedDB.deleted).toEqual([]);
  });

  it('waits out the crypto database too, which is the one the owner met', async () => {
    // The name in his console was `allo-matrix:FNgFkAe4aZ::matrix-sdk-crypto`.
    // The synced state went; this one was open in another tab.
    const indexedDB = new FakeIndexedDB();
    indexedDB.present.push('allo-matrix:DEVICE1::matrix-sdk-crypto');
    indexedDB.block.add('allo-matrix:DEVICE1::matrix-sdk-crypto');
    const reports: boolean[] = [];

    const failure = await eraseWebStore(STORE, indexedDB.factory(), {
      onBlocked: (blocked) => reports.push(blocked),
      blockedTimeoutMs: BOUND_MS,
    }).catch((error: unknown) => error);

    expect(reports).toEqual([true]);
    expect(failure).toBeInstanceOf(MatrixStoreEraseBlockedError);
    expect((failure as MatrixStoreEraseBlockedError).names).toEqual([
      'allo-matrix:DEVICE1::matrix-sdk-crypto',
    ]);
    // The one that did go, went.
    expect(indexedDB.deleted).toEqual(['matrix-js-sdk:allo-matrix']);
  });
});
