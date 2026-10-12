/**
 * postgres.js and `Bun.SQL` against ONE database: what each writes, the other
 * reads back identically, through the column kinds this schema uses.
 *
 * The rest of the suite runs on whichever driver `DATABASE_DRIVER` selects, so
 * it proves each driver works with the repositories on its own. What it cannot
 * prove is that the two AGREE: that a row the old task wrote during a rollout
 * reads the same on the new one, and that a value is stored as the same thing
 * rather than as something each driver happens to read back as itself. A jsonb
 * string double-encoded on write, for instance, reads back fine through the
 * driver that wrote it. So this file opens both, writes with each, reads with
 * each, and asks the server (`jsonb_typeof`, `octet_length`) what it stored.
 *
 * The table is this file's own, built from the same column helpers the schema
 * uses (`bytea`, `timestamptz`, `createdAt` from `@oxy.so/db`, drizzle's
 * `bigint({ mode: 'number' })`, `jsonb`, `text().array()`), so no fixture has
 * to satisfy a real table's foreign keys.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  bytea,
  constraintNameOf,
  createDatabase,
  createdAt,
  type DatabaseDriver,
  isCheckViolation,
  isUniqueViolation,
  sqlStateOf,
  timestamptz,
} from '@oxy.so/db';
import { eq, like, sql } from 'drizzle-orm';
import { bigint, boolean, check, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import type postgres from 'postgres';
import {
  closePostgres,
  connectPostgres,
  getDatabaseDriver,
  getDb,
  type OpenDatabase,
  openDatabase,
} from '../../db';
import { readDatabaseDriver } from '../../db/driver';
import * as schema from '../../db/schema';
import { setUpTestDatabase, type TestDatabaseHandle } from '../../db/testDatabase';

const DRIVERS: readonly DatabaseDriver[] = ['postgres-js', 'bun-sql'];

const parity = pgTable(
  'driver_parity',
  {
    id: text().primaryKey(),
    payload: bytea().notNull(),
    seq: bigint({ mode: 'number' }).notNull(),
    attempts: integer().notNull(),
    flag: boolean().notNull(),
    doc: jsonb(),
    tags: text().array().notNull(),
    at: timestamptz(),
    createdAt: createdAt(),
  },
  (t) => [check('driver_parity_attempts_check', sql`${t.attempts} >= -10`)],
);

const DDL = `
  create table driver_parity (
    id text primary key,
    payload bytea not null,
    seq bigint not null,
    attempts integer not null,
    flag boolean not null,
    doc jsonb,
    tags text[] not null,
    at timestamptz,
    created_at timestamptz not null default date_trunc('milliseconds', now()),
    constraint driver_parity_attempts_check check (attempts >= -10)
  )
`;

type ParityRow = Omit<typeof parity.$inferInsert, 'id' | 'createdAt'>;

/** Every value shape the schema stores, including the edges each driver could get wrong. */
const ROWS: Readonly<Record<string, ParityRow>> = {
  full: {
    payload: Buffer.from([0, 1, 2, 127, 128, 254, 255, 0]),
    seq: Number.MAX_SAFE_INTEGER,
    attempts: -5,
    flag: true,
    doc: {
      n: 1.5,
      big: 2 ** 53 - 1,
      nested: { list: [1, 'x', null, true, { deep: [] }] },
      text: 'ñ 😀 "quoted" \\ back\nline',
      empty: {},
    },
    tags: ['a', 'b,c', '"q"', 'with space', '{brace}', 'NULL', 'ñ😀', ''],
    at: new Date('2024-03-31T01:30:00.123Z'),
  },
  empty: {
    payload: Buffer.alloc(0),
    seq: 0,
    attempts: 0,
    flag: false,
    doc: null,
    tags: [],
    at: null,
  },
  scalarString: {
    payload: Buffer.from('plain text bytes', 'utf8'),
    seq: 1,
    attempts: 1,
    flag: true,
    doc: 'just a string',
    tags: ['one'],
    at: new Date(0),
  },
  scalarArray: {
    payload: Buffer.from([255]),
    seq: 2 ** 40,
    attempts: 2_147_483_647,
    flag: false,
    doc: [1, 'two', { three: 3 }],
    tags: ['x', 'y'],
    at: new Date('9999-12-31T23:59:59.999Z'),
  },
  scalarNumberAndFalse: {
    payload: Buffer.from([0]),
    seq: 3,
    attempts: -10,
    flag: false,
    doc: false,
    tags: ['z'],
    at: new Date('2026-10-25T00:59:59.999Z'),
  },
};

/** What the server should report for each row's jsonb (null = SQL NULL). */
const JSONB_TYPES: Readonly<Record<string, string | null>> = {
  full: 'object',
  empty: null,
  scalarString: 'string',
  scalarArray: 'array',
  scalarNumberAndFalse: 'boolean',
};

let handle: TestDatabaseHandle;
let raw: postgres.Sql;
const open = new Map<DatabaseDriver, OpenDatabase>();

function dbOf(driver: DatabaseDriver) {
  const database = open.get(driver);
  if (!database) throw new Error(`no ${driver} handle`);
  return database.db;
}

beforeAll(async () => {
  handle = await setUpTestDatabase();
  raw = createDatabase({ databaseUrl: handle.databaseUrl, schema }).client;
  await raw.unsafe(DDL);
  for (const driver of DRIVERS) open.set(driver, openDatabase(handle.databaseUrl, driver));
}, 180_000);

afterAll(async () => {
  for (const database of open.values()) await database.close();
  await raw?.end();
  await handle?.drop();
});

describe('the runtime handle', () => {
  it('runs on the driver DATABASE_DRIVER names', async () => {
    const expected = readDatabaseDriver();
    connectPostgres(handle.databaseUrl);
    try {
      expect(getDatabaseDriver()).toBe(expected);
      // A `Bun.SQL` instance is a plain function, so `instanceof` cannot tell
      // the two apart; `beginDistributed` exists on Bun.SQL and not on postgres.js.
      const client = Reflect.get(getDb(), '$client');
      expect(typeof Reflect.get(client, 'beginDistributed') === 'function').toBe(
        expected === 'bun-sql',
      );
      await getDb().select({ one: sql<number>`1` }).from(parity).limit(0);
    } finally {
      await closePostgres();
    }
  });
});

describe.each(DRIVERS)('written by %s', (writer) => {
  const idOf = (key: string) => `${writer}:${key}`;

  beforeAll(async () => {
    await dbOf(writer)
      .insert(parity)
      .values(Object.entries(ROWS).map(([key, row]) => ({ id: idOf(key), ...row })));
  });

  it.each(DRIVERS)('reads back identically through %s', async (reader) => {
    const rows = await dbOf(reader)
      .select()
      .from(parity)
      .where(like(parity.id, `${writer}:%`));
    expect(rows).toHaveLength(Object.keys(ROWS).length);
    for (const [key, expected] of Object.entries(ROWS)) {
      const row = rows.find((candidate) => candidate.id === idOf(key));
      expect(row).toBeDefined();
      const { id: _id, createdAt: stamped, ...values } = row as typeof parity.$inferSelect;
      expect(values as ParityRow).toEqual(expected);
      expect(Buffer.isBuffer(values.payload)).toBe(true);
      expect(stamped).toBeInstanceOf(Date);
    }
  });

  it('stores each value as the type it is, not as a string of it', async () => {
    const stored = await raw<
      { id: string; doc_type: string | null; payload_bytes: number; tags_count: number }[]
    >`
      select id, jsonb_typeof(doc) as doc_type, octet_length(payload) as payload_bytes,
        cardinality(tags) as tags_count
      from driver_parity where id like ${`${writer}:%`}
    `;
    for (const [key, row] of Object.entries(ROWS)) {
      const found = stored.find((candidate) => candidate.id === idOf(key));
      expect(found?.doc_type ?? null).toBe(JSONB_TYPES[key]);
      expect(found?.payload_bytes).toBe(row.payload.length);
      expect(found?.tags_count).toBe(row.tags.length);
    }
  });
});

describe.each(DRIVERS)('%s', (driver) => {
  it('names the SQLSTATE and constraint of a unique violation', async () => {
    const db = dbOf(driver);
    const row = { id: `${driver}:dupe`, ...ROWS.empty };
    await db.insert(parity).values(row);
    const error = await db
      .insert(parity)
      .values(row)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(sqlStateOf(error)).toBe('23505');
    expect(constraintNameOf(error)).toBe('driver_parity_pkey');
    expect(isUniqueViolation(error, 'driver_parity_pkey')).toBe(true);
  });

  it('names the SQLSTATE and constraint of a CHECK violation', async () => {
    const error = await dbOf(driver)
      .insert(parity)
      .values({ id: `${driver}:check`, ...ROWS.empty, attempts: -11 })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(sqlStateOf(error)).toBe('23514');
    expect(isCheckViolation(error, 'driver_parity_attempts_check')).toBe(true);
  });

  it('rolls a transaction back whole, and a nested one back alone', async () => {
    const db = dbOf(driver);
    const outer = `${driver}:tx-outer`;
    const inner = `${driver}:tx-inner`;
    const failure = await db
      .transaction(async (tx) => {
        await tx.insert(parity).values({ id: `${driver}:tx-lost`, ...ROWS.empty });
        throw new Error('roll back');
      })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(failure).toBeInstanceOf(Error);

    await db.transaction(async (tx) => {
      await tx.insert(parity).values({ id: outer, ...ROWS.empty });
      await tx
        .transaction(async (nested) => {
          await nested.insert(parity).values({ id: inner, ...ROWS.empty });
          throw new Error('roll back the savepoint only');
        })
        .catch(() => undefined);
    });

    const kept = await db
      .select({ id: parity.id })
      .from(parity)
      .where(like(parity.id, `${driver}:tx-%`));
    expect(kept.map((row) => row.id)).toEqual([outer]);
  });

  it('sees an update committed by the other driver', async () => {
    const id = `${driver}:cross`;
    const other = DRIVERS.find((candidate) => candidate !== driver) as DatabaseDriver;
    await dbOf(driver)
      .insert(parity)
      .values({ id, ...ROWS.empty });
    await dbOf(other)
      .update(parity)
      .set({ seq: sql`${parity.seq} + 1`, doc: { by: other } })
      .where(eq(parity.id, id));
    const [row] = await dbOf(driver).select().from(parity).where(eq(parity.id, id));
    expect(row.seq).toBe(1);
    expect(row.doc).toEqual({ by: other });
  });
});

/**
 * Where the two DO differ: a raw read, which no column mapper touches. Pinned
 * so a driver upgrade that changes either side is seen, and so nobody reads a
 * timestamp or a nullable array element through raw SQL and expects it to
 * survive a driver switch. Nothing in `src/` does today (raw selects are
 * `count(*)::int` and `1`).
 */
describe('raw reads (db.execute), which no column mapper normalises', () => {
  const RAW = sql`
    select 9007199254740993::int8 as i8, count(*) as n, 1.50::numeric as num,
      '2024-03-31T01:30:00.123Z'::timestamptz as tstz,
      array['a', null]::text[] as arr, '\\x00ff'::bytea as bytes, '{"a":1}'::jsonb as doc
  `;

  async function rawRow(driver: DatabaseDriver): Promise<Record<string, unknown>> {
    const rows = await dbOf(driver).execute(RAW);
    return rows[0];
  }

  it('agree on int8, count, numeric, bytea and jsonb', async () => {
    const [pg, bun] = await Promise.all(DRIVERS.map(rawRow));
    for (const row of [pg, bun]) {
      expect(row.i8).toBe('9007199254740993');
      expect(row.n).toBe('1');
      expect(row.num).toBe('1.50');
      expect(Buffer.isBuffer(row.bytes)).toBe(true);
      expect([...(row.bytes as Buffer)]).toEqual([0, 255]);
      expect(row.doc).toEqual({ a: 1 });
    }
  });

  it('differ on timestamptz (string vs Date) and on a NULL array element ("NULL" vs null)', async () => {
    const [pg, bun] = await Promise.all(DRIVERS.map(rawRow));
    expect(typeof pg.tstz).toBe('string');
    expect(new Date(pg.tstz as string).toISOString()).toBe('2024-03-31T01:30:00.123Z');
    expect(bun.tstz).toBeInstanceOf(Date);
    expect((bun.tstz as Date).toISOString()).toBe('2024-03-31T01:30:00.123Z');
    expect(pg.arr).toEqual(['a', 'NULL']);
    expect(bun.arr).toEqual(['a', null]);
  });
});
