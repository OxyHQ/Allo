import { describe, expect, it } from 'bun:test';
import { readDatabaseDriver } from '../../db/driver';

describe('DATABASE_DRIVER', () => {
  it('defaults to postgres.js when unset or blank, so merging the flag changes nothing', () => {
    expect(readDatabaseDriver({})).toBe('postgres-js');
    expect(readDatabaseDriver({ DATABASE_DRIVER: '' })).toBe('postgres-js');
    expect(readDatabaseDriver({ DATABASE_DRIVER: '   ' })).toBe('postgres-js');
  });

  it('selects each driver by its exact name', () => {
    expect(readDatabaseDriver({ DATABASE_DRIVER: 'postgres-js' })).toBe('postgres-js');
    expect(readDatabaseDriver({ DATABASE_DRIVER: 'bun-sql' })).toBe('bun-sql');
    expect(readDatabaseDriver({ DATABASE_DRIVER: ' bun-sql\n' })).toBe('bun-sql');
  });

  it('refuses a value that names no driver instead of quietly keeping the default', () => {
    for (const value of ['bunsql', 'bun', 'Bun-SQL', 'postgres', 'pg']) {
      expect(() => readDatabaseDriver({ DATABASE_DRIVER: value })).toThrow(
        /DATABASE_DRIVER=.* is not a database driver/,
      );
    }
  });
});
