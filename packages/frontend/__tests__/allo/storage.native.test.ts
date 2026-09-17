import { SqliteStorage, escapeLikePrefix, type KvDatabase } from '@/lib/allo/storage.native';

/**
 * The SQLite adapter, against an in-memory database that implements the
 * subset it uses and records every call. What matters here is the SHAPE of
 * what reaches SQLite: that a batch is wrapped in one transaction, that the
 * prefix scan escapes LIKE's wildcards, and that a set is an upsert.
 */

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
}));

type Call = { sql: string; params: unknown[] };

class FakeSqlite implements KvDatabase {
  rows = new Map<string, Uint8Array>();
  calls: Call[] = [];
  /** The transaction depth at the moment of each call, so a batch can be checked for being inside one. */
  depths: number[] = [];
  private depth = 0;
  /** A key whose write throws, to abort a transaction mid-batch. */
  failOnKey: string | null = null;

  async execAsync(source: string): Promise<void> {
    this.calls.push({ sql: source, params: [] });
    this.depths.push(this.depth);
  }

  async runAsync(source: string, params: (string | Uint8Array)[]): Promise<unknown> {
    this.calls.push({ sql: source, params });
    this.depths.push(this.depth);
    if (source.startsWith('INSERT OR REPLACE')) {
      const [key, value] = params as [string, Uint8Array];
      if (key === this.failOnKey) throw new Error('disk full');
      this.rows.set(key, new Uint8Array(value));
    } else if (source.startsWith('DELETE')) {
      this.rows.delete(params[0] as string);
    }
    return { changes: 1 };
  }

  async getFirstAsync<T>(source: string, params: (string | Uint8Array)[]): Promise<T | null> {
    this.calls.push({ sql: source, params });
    const value = this.rows.get(params[0] as string);
    return value ? ({ value } as T) : null;
  }

  async getAllAsync<T>(source: string, params: (string | Uint8Array)[]): Promise<T[]> {
    this.calls.push({ sql: source, params });
    // A LIKE with ESCAPE, evaluated the way SQLite would: the pattern is
    // `<escaped prefix>%`, so unescape it and compare as a prefix.
    const pattern = params[0] as string;
    const prefix = pattern.slice(0, -1).replace(/\\(.)/g, '$1');
    return [...this.rows.keys()]
      .filter((k) => k.startsWith(prefix))
      .sort()
      .map((key) => ({ key }) as T);
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    const snapshot = new Map(this.rows);
    this.depth += 1;
    try {
      await task();
    } catch (error) {
      this.rows = snapshot;
      throw error;
    } finally {
      this.depth -= 1;
    }
  }
}

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

async function storage(): Promise<{ adapter: SqliteStorage; db: FakeSqlite }> {
  const db = new FakeSqlite();
  return { adapter: await SqliteStorage.open(db), db };
}

describe('escapeLikePrefix', () => {
  it('escapes the wildcards and the escape character itself', () => {
    expect(escapeLikePrefix('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });

  it('leaves an ordinary namespace alone', () => {
    expect(escapeLikePrefix('allo/allo/acc-1/conversation/')).toBe('allo/allo/acc-1/conversation/');
  });
});

describe('SqliteStorage', () => {
  it('creates the table on open', async () => {
    const { db } = await storage();
    expect(db.calls[0].sql).toMatch(/CREATE TABLE IF NOT EXISTS kv/);
  });

  it('round-trips bytes and upserts', async () => {
    const { adapter, db } = await storage();
    await adapter.set('k', bytes('one'));
    await adapter.set('k', bytes('two'));
    expect(text(await adapter.get('k'))).toBe('two');
    expect(db.calls.filter((c) => c.sql.startsWith('INSERT OR REPLACE'))).toHaveLength(2);
    await adapter.delete('k');
    expect(await adapter.get('k')).toBeUndefined();
  });

  it('scans a prefix with LIKE and an ESCAPE clause, wildcards escaped', async () => {
    const { adapter, db } = await storage();
    await adapter.set('ns_1/a', bytes(''));
    await adapter.set('nsX1/b', bytes(''));
    await adapter.set('ns_1/c', bytes(''));

    const keys = await adapter.list('ns_1/');

    expect(keys).toEqual(['ns_1/a', 'ns_1/c']);
    const scan = db.calls.at(-1)!;
    expect(scan.sql).toMatch(/LIKE \? ESCAPE '\\'/);
    expect(scan.params[0]).toBe('ns\\_1/%');
  });

  it('runs a batch inside ONE transaction', async () => {
    const { adapter, db } = await storage();
    const before = db.calls.length;
    await adapter.batch([
      { type: 'set', key: 'a', value: bytes('1') },
      { type: 'set', key: 'b', value: bytes('2') },
      { type: 'delete', key: 'zzz' },
    ]);
    const batched = db.depths.slice(before);
    expect(batched).toHaveLength(3);
    expect(batched.every((depth) => depth === 1)).toBe(true);
    expect(text(await adapter.get('a'))).toBe('1');
  });

  it('leaves NOTHING of a batch that fails half-way', async () => {
    const { adapter, db } = await storage();
    await adapter.set('cursor', bytes('before'));
    db.failOnKey = 'event/2';
    await expect(
      adapter.batch([
        { type: 'set', key: 'event/1', value: bytes('e1') },
        { type: 'set', key: 'event/2', value: bytes('e2') },
        { type: 'set', key: 'cursor', value: bytes('after') },
      ]),
    ).rejects.toThrow(/disk full/);
    db.failOnKey = null;
    expect(await adapter.get('event/1')).toBeUndefined();
    expect(text(await adapter.get('cursor'))).toBe('before');
  });

  it('opens no transaction for an empty batch', async () => {
    const { adapter, db } = await storage();
    const before = db.calls.length;
    await adapter.batch([]);
    expect(db.calls.length).toBe(before);
  });

  it('answers a BLOB that came back as an ArrayBuffer as bytes', async () => {
    const db = new FakeSqlite();
    const adapter = await SqliteStorage.open(db);
    db.getFirstAsync = async () => ({ value: bytes('buf').buffer }) as never;
    expect(text(await adapter.get('k'))).toBe('buf');
  });
});
