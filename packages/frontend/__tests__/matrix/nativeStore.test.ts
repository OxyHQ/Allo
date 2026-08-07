import { MatrixStoreNotErasedError, MatrixStoreUnavailableError } from '@/lib/matrix/errors';
import { eraseAlloChatStore, resolveAlloChatStore } from '@/lib/matrix/store.native';
import type { AlloClientStore } from '@/lib/matrix/types';

/**
 * Where the native client keeps its data, and what erasing it has to guarantee.
 *
 * The interesting half is not the deletion, it is the check afterwards. The
 * SQLite files may still be open when the erase runs — the client that owns them
 * is closed first, but the Rust object behind it is released by a garbage
 * collector nothing can wait for — so `delete()` returning is not the same
 * statement as "the directory is gone". A quiet non-deletion is exactly the
 * failure that ends with the next account opening the last account's keys, and
 * unlike a throw there is nothing in the log to say it happened.
 */

/** The filesystem, as much of it as `store.native.ts` can observe. */
interface MockFilesystem {
  /** Directories that exist. Keyed by normalised URI. */
  readonly present: Set<string>;
  /** Directories whose `delete()` does nothing at all, silently. */
  readonly undeletable: Set<string>;
  /** Directories whose `delete()` throws. */
  readonly refusing: Map<string, Error>;
  /** Every `delete()` attempted, in order. */
  readonly deletes: string[];
}

let mockState: MockFilesystem | undefined;

/**
 * The fake filesystem, built on first use.
 *
 * Reached through a hoisted function rather than held in a `const`, because
 * `jest.mock` is hoisted above every import and the factory below is evaluated
 * while `store.native.ts` is being imported — before any `const` in this file has
 * run. A function declaration is hoisted with it; the state it returns is not
 * touched until a test asks for it.
 */
function mockFilesystem(): MockFilesystem {
  mockState ??= {
    present: new Set<string>(),
    undeletable: new Set<string>(),
    refusing: new Map<string, Error>(),
    deletes: [],
  };
  return mockState;
}

/**
 * Joins path segments the way `expo-file-system` does, to one canonical URI.
 *
 * The leading segment keeps its own slashes — `file:///app` has three and they
 * all mean something — while every joint between segments collapses to one. Both
 * ways the module builds a `Directory` have to land on the same string: once from
 * `Paths.document` plus a name, and once from the `file://` URI it rebuilds out
 * of the plain path it handed the SDK.
 */
function mockNormalize(segments: readonly string[]): string {
  const [head = '', ...rest] = segments;
  return [head.replace(/\/+$/, ''), ...rest.map((segment) => segment.replace(/^\/+|\/+$/g, ''))]
    .filter((segment) => segment !== '')
    .join('/');
}

jest.mock('expo-file-system', () => ({
  Paths: { document: 'file:///app/documents/', cache: 'file:///app/cache/' },
  Directory: class {
    readonly uri: string;

    constructor(...segments: string[]) {
      this.uri = mockNormalize(segments);
    }

    get exists(): boolean {
      return mockFilesystem().present.has(this.uri);
    }

    delete(): void {
      const filesystem = mockFilesystem();
      filesystem.deletes.push(this.uri);
      const refusal = filesystem.refusing.get(this.uri);
      if (refusal !== undefined) {
        throw refusal;
      }
      if (filesystem.undeletable.has(this.uri)) {
        return;
      }
      filesystem.present.delete(this.uri);
    }
  },
}));

const DATA = '/app/documents/matrix';
const CACHE = '/app/cache/matrix';
const STORE: AlloClientStore = { kind: 'filesystem', dataPath: DATA, cachePath: CACHE };

beforeEach(() => {
  const filesystem = mockFilesystem();
  filesystem.present.clear();
  filesystem.undeletable.clear();
  filesystem.refusing.clear();
  filesystem.deletes.length = 0;
});

describe('resolveAlloChatStore', () => {
  it('gives the Rust SDK a path and not a URI', () => {
    // It hands what it is given to SQLite. A `file://` URI opens nothing, and the
    // percent-encoding a URI carries would name a different directory.
    expect(resolveAlloChatStore()).toEqual({
      kind: 'filesystem',
      dataPath: DATA,
      cachePath: CACHE,
    });
  });

  it('keeps the state store out of the cache directory', () => {
    // The state store holds the device's encryption keys and belongs where the
    // system will not reclaim it; the event cache is a cache and a phone running
    // out of space should be allowed to take it.
    const store = resolveAlloChatStore();
    expect(store.kind === 'filesystem' && store.dataPath).not.toBe(
      store.kind === 'filesystem' && store.cachePath,
    );
  });
});

describe('eraseAlloChatStore', () => {
  it('deletes both directories', async () => {
    mockFilesystem().present.add(`file://${DATA}`).add(`file://${CACHE}`);

    await eraseAlloChatStore(STORE);

    expect(mockFilesystem().present.size).toBe(0);
  });

  it('does not delete the same directory twice when both paths are one', async () => {
    // A deployment is free to point both at one directory: the SDK allows it, and
    // the second delete would throw on a directory that is already gone.
    mockFilesystem().present.add(`file://${DATA}`);

    await eraseAlloChatStore({ kind: 'filesystem', dataPath: DATA, cachePath: DATA });

    expect(mockFilesystem().deletes).toEqual([`file://${DATA}`]);
  });

  it('does nothing for a store that was never on disk', async () => {
    await eraseAlloChatStore({ kind: 'in-memory' });

    expect(mockFilesystem().deletes).toEqual([]);
  });

  it('skips a directory that is not there rather than deleting nothing loudly', async () => {
    await eraseAlloChatStore(STORE);

    expect(mockFilesystem().deletes).toEqual([]);
  });

  it('refuses to report success for a directory that is still there', async () => {
    // The whole point of the file. `delete()` returned, the directory survived,
    // and the runtime is about to open it as somebody else.
    mockFilesystem().present.add(`file://${DATA}`);
    mockFilesystem().undeletable.add(`file://${DATA}`);

    await expect(eraseAlloChatStore(STORE)).rejects.toThrow(MatrixStoreNotErasedError);
  });

  it('names the directories that survived', async () => {
    mockFilesystem().present.add(`file://${DATA}`).add(`file://${CACHE}`);
    mockFilesystem().undeletable.add(`file://${DATA}`).add(`file://${CACHE}`);

    const failure = await eraseAlloChatStore(STORE).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MatrixStoreNotErasedError);
    expect((failure as MatrixStoreNotErasedError).names).toEqual([DATA, CACHE]);
  });

  it('still clears the cache when the state store cannot go', async () => {
    // Attempting both before raising anything. Stopping at the first survivor
    // would leave behind a directory that could have been reclaimed.
    mockFilesystem().present.add(`file://${DATA}`).add(`file://${CACHE}`);
    mockFilesystem().undeletable.add(`file://${DATA}`);

    await expect(eraseAlloChatStore(STORE)).rejects.toThrow(MatrixStoreNotErasedError);

    expect(mockFilesystem().present.has(`file://${CACHE}`)).toBe(false);
  });

  it('lets a delete that throws propagate', async () => {
    // The loud failure, left alone: it already says what went wrong, and wrapping
    // it would throw away the platform's own reason.
    mockFilesystem().present.add(`file://${DATA}`);
    mockFilesystem().refusing.set(`file://${DATA}`, new Error('permission denied'));

    await expect(eraseAlloChatStore(STORE)).rejects.toThrow('permission denied');
  });

  it('refuses a path a file URI would read as something else', async () => {
    // `#` starts a fragment and `?` starts a query. Encoding them away would name
    // a different directory, which is the one mistake this could make that ends
    // in deleting nothing and reporting success.
    await expect(
      eraseAlloChatStore({
        kind: 'filesystem',
        dataPath: '/app/documents/matrix#1',
        cachePath: CACHE,
      }),
    ).rejects.toThrow(MatrixStoreUnavailableError);
  });
});
