/**
 * `StorageAdapter` over `expo-sqlite`, for iOS and Android.
 *
 * One database, one table: `kv(key TEXT PRIMARY KEY, value BLOB)`. Every value
 * the SDK writes through here is already ciphertext — `@allo/core` encrypts at
 * rest with a key that lives in `secrets.native.ts` — so this file never sees a
 * message, and a copy of `allo.db` is worthless without the Keychain entry.
 *
 * `batch` runs inside one transaction. That is the property the SDK is built
 * on: a sync tick writes a cursor, a group state and a page of events as one
 * unit, and a process killed halfway through must leave the previous unit
 * intact rather than a cursor that has moved past events that never landed.
 *
 * Nothing here may fall back to AsyncStorage. There is no "if SQLite is not
 * available" branch on purpose: a device without SQLite is a device this
 * adapter cannot serve, and a silent fallback to an unencrypted, unbatched key
 * value store would be worse than an error.
 */
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import type { StorageAdapter, StorageOp } from '@allo/core';

export const DATABASE_NAME = 'allo.db';

/** The character `escapeLikePrefix` escapes with. Declared once so the SQL and the escaping agree. */
export const LIKE_ESCAPE = '\\';

/**
 * A prefix made safe for `LIKE ? ESCAPE '\'`.
 *
 * `%` and `_` are wildcards in a LIKE pattern, and a key namespace is
 * `allo/<appId>/<accountId>/...`, where an account id or an event id may carry
 * an underscore. Unescaped, `list('x_y')` would also match `xzy`.
 */
export function escapeLikePrefix(prefix: string): string {
  return prefix.replace(/[\\%_]/g, (c) => LIKE_ESCAPE + c);
}

/** The minimum of `SQLiteDatabase` this adapter uses, so a test can hand in a fake. */
export interface KvDatabase {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, params: (string | Uint8Array)[]): Promise<unknown>;
  getFirstAsync<T>(source: string, params: (string | Uint8Array)[]): Promise<T | null>;
  getAllAsync<T>(source: string, params: (string | Uint8Array)[]): Promise<T[]>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export class SqliteStorage implements StorageAdapter {
  private constructor(private readonly db: KvDatabase) {}

  /** Opens (or creates) the table and answers an adapter over it. */
  static async open(db: KvDatabase): Promise<SqliteStorage> {
    await db.execAsync('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL)');
    return new SqliteStorage(db);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const row = await this.db.getFirstAsync<{ value: Uint8Array | ArrayBuffer }>('SELECT value FROM kv WHERE key = ?', [key]);
    return row ? toBytes(row.value) : undefined;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await this.db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [key, value]);
  }

  async delete(key: string): Promise<void> {
    await this.db.runAsync('DELETE FROM kv WHERE key = ?', [key]);
  }

  async list(prefix: string): Promise<string[]> {
    const rows = await this.db.getAllAsync<{ key: string }>(
      `SELECT key FROM kv WHERE key LIKE ? ESCAPE '${LIKE_ESCAPE}' ORDER BY key`,
      [`${escapeLikePrefix(prefix)}%`],
    );
    return rows.map((row) => row.key);
  }

  async batch(ops: StorageOp[]): Promise<void> {
    if (ops.length === 0) return;
    await this.db.withTransactionAsync(async () => {
      for (const op of ops) {
        if (op.type === 'set') {
          await this.db.runAsync('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [op.key, op.value]);
        } else {
          await this.db.runAsync('DELETE FROM kv WHERE key = ?', [op.key]);
        }
      }
    });
  }
}

function toBytes(value: Uint8Array | ArrayBuffer): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

let opening: Promise<SqliteStorage> | null = null;

/** The app's one storage adapter. Opened once; every client shares the database and is namespaced by core. */
export function createStorage(): Promise<StorageAdapter> {
  if (!opening) {
    opening = openDatabaseAsync(DATABASE_NAME).then((db: SQLiteDatabase) => SqliteStorage.open(db));
  }
  return opening;
}
