/**
 * The Postgres handle for this service.
 *
 * Built through `createDatabase()` from `@oxy.so/db` rather than a local
 * `drizzle(postgres(url))`, because that is what guarantees the handle carries
 * `DATABASE_CASING` — so what queries REFERENCE matches what the migrations
 * CREATED. Getting that wrong produces `column "oxyUserId" does not exist` at
 * runtime against a schema that looks correct in the editor.
 */

import {
  type BunSqlClientOptions,
  createDatabase,
  type DatabaseDriver,
  type RawSqlClient,
} from '@oxy.so/db';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { readDatabaseDriver } from './driver';
import * as schema from './schema';

/**
 * What a raw `execute` resolves to on EITHER driver: an array of row objects.
 * Both attach result metadata to that array, under different names
 * (postgres.js: `count`, `command`, `columns`, `statement`, `state`; Bun:
 * `count`, `command`, `affectedRows`, `lastInsertRowid`), so the array is all
 * both promise.
 */
interface AnyDriverQueryResultHKT extends PgQueryResultHKT {
  // `any` rather than `unknown` in the value position: postgres.js types its
  // row as `{ [column: string]: any }`, which `unknown` would not accept.
  // biome-ignore lint/suspicious/noExplicitAny: matches postgres.js's own `Row`.
  type: Record<string, any>[];
}

/**
 * The drizzle handle, on whichever client `DATABASE_DRIVER` selected (see
 * `./driver`).
 *
 * Named as the `PgDatabase` both drivers' handles are, rather than as either
 * one's own type, so a repository cannot come to depend on what only one
 * driver returns: one driver's result metadata on a raw `execute`, or the
 * `$client` underneath. Neither is used today, and a call that needs one now
 * fails to compile instead of failing on one driver in production.
 *
 * Raw reads are where the drivers DIFFER even so: through `execute` or an
 * untyped `sql` field, postgres.js returns a timestamp as a string and Bun as
 * a `Date`, so read a timestamp through a typed column. And postgres.js reads
 * a NULL element of a `text[]` as the string `'NULL'` where Bun reads `null`;
 * nothing here writes one (every array column is a non-null `string[]`).
 * `driverParity.realdb.test.ts` pins both.
 */
export type AlloDatabase = PgDatabase<AnyDriverQueryResultHKT, typeof schema>;

/**
 * The handle `db.transaction(...)` hands its callback.
 *
 * Derived from the database type rather than named as `PgTransaction<…>` so it
 * cannot disagree with what drizzle actually passes, and so a drizzle upgrade
 * that reshapes those generics is a compile error here rather than a silent
 * widening.
 *
 * This lives beside {@link AlloDatabase} rather than in the moderation domain
 * that first needed it. "What a repository accepts" is a property of this
 * service's database, not of one domain: a messaging repository that needs a
 * transaction handle would otherwise have to import a type out of
 * `db/moderation/`, which reads as a dependency it does not have, or declare its
 * own — and two spellings of one handle can disagree about what a transaction
 * is.
 */
export type AlloTransaction = Parameters<Parameters<AlloDatabase['transaction']>[0]>[0];

/** What a repository accepts: the pool, or a live transaction. */
export type AlloDatabaseOrTransaction = AlloDatabase | AlloTransaction;

/** An open pool on either driver, reduced to what this service does with it. */
export interface OpenDatabase {
  readonly driver: DatabaseDriver;
  readonly db: AlloDatabase;
  /** The client underneath, for the migration-ledger check (`unsafe` only). */
  readonly client: RawSqlClient;
  /** One `select 1` round trip. */
  ping(): Promise<void>;
  /** Close every connection, waiting for in-flight queries. */
  close(): Promise<void>;
}

/**
 * `Bun.SQL` options that reproduce the postgres.js DEFAULTS this service has
 * always run on (it never set any), under Bun's names, with ONE deliberate
 * exception: prepared statements.
 *
 * Bun's own defaults already match postgres.js on pool size (10), idle timeout
 * (none) and connect timeout (30 s). `maxLifetime` is set because Bun never
 * recycles a connection unless told to; this is postgres.js's own default, a
 * random 30 to 60 minutes (postgres.js draws it per connection; Bun takes one
 * number, so it is drawn once per process). TLS is left to the URL's
 * `sslmode`, which both clients read the same way.
 *
 * **`prepare: false` is load-bearing, not tuning.** drizzle's `jsonb()`
 * stringifies the value before handing it to the driver, and on a prepared
 * statement Bun 1.4.3 learns the parameter is `jsonb` and JSON-encodes that
 * string AGAIN, so every jsonb write lands as a jsonb STRING holding the JSON
 * text. drizzle's reader `JSON.parse`s a string, so every read through drizzle
 * looks right on both drivers and the defect is invisible to any test that
 * only round-trips through drizzle; `jsonb_typeof`, `->` and `@>` see the
 * truth. Unprepared, Bun sends the string untyped and the server parses it as
 * JSON, as postgres.js does. `driverParity.realdb.test.ts` asks the server
 * what was stored, and fails if this is flipped back.
 *
 * One difference cannot be configured away: Bun 1.4.3 opens all `max`
 * connections on the first query and keeps them, where postgres.js opens them
 * as load needs them. A task therefore holds 10 connections from its first
 * request, which is the ceiling it could already reach.
 */
const BUN_SQL_OPTIONS: BunSqlClientOptions = {
  max: 10,
  idleTimeout: 0,
  maxLifetime: 60 * (30 + Math.random() * 30),
  connectionTimeout: 30,
  prepare: false,
};

/**
 * Open a pool on `databaseUrl` through `driver` (by default, the one
 * `DATABASE_DRIVER` names). {@link connectPostgres} keeps the process's one
 * pool; a test that needs a handle of its own opens one here so it runs on the
 * same driver the service would.
 */
export function openDatabase(
  databaseUrl: string,
  driver: DatabaseDriver = readDatabaseDriver(),
): OpenDatabase {
  if (driver === 'bun-sql') {
    const { db, client } = createDatabase({
      databaseUrl,
      schema,
      driver,
      client: BUN_SQL_OPTIONS,
    });
    return {
      driver,
      db,
      client,
      ping: async () => {
        await client`select 1`;
      },
      close: () => client.close(),
    };
  }
  const { db, client } = createDatabase({ databaseUrl, schema });
  return {
    driver,
    db,
    client,
    ping: async () => {
      await client`select 1`;
    },
    close: () => client.end(),
  };
}

let handle: OpenDatabase | null = null;

/**
 * Open the pool. Not lazy: a bad `DATABASE_URL` should fail at boot rather than
 * on the first request that happens to touch a table. A `DATABASE_DRIVER` that
 * names no driver fails here too, for the same reason.
 */
export function connectPostgres(databaseUrl: string): AlloDatabase {
  if (handle) return handle.db;
  handle = openDatabase(databaseUrl);
  return handle.db;
}

/** The driver the open pool runs on, or `null` before {@link connectPostgres}. */
export function getDatabaseDriver(): DatabaseDriver | null {
  return handle?.driver ?? null;
}

export function getDb(): AlloDatabase {
  if (!handle) {
    throw new Error('Postgres is not connected — call connectPostgres() during startup');
  }
  return handle.db;
}

/**
 * Whether the pool has been proven to reach the server. `null` means "not yet,
 * or the last attempt failed" — cleared on failure so the next caller retries.
 */
let reachability: Promise<void> | null = null;

async function probe(): Promise<void> {
  if (!handle) {
    throw new Error('Postgres is not connected — call connectPostgres() during startup');
  }
  await handle.ping();
}

/**
 * Prove the pool can reach the server — ONCE, on cold start.
 *
 * This is the shape `connectToDatabase()` had, and the shape matters more than
 * the mechanism. That function returned early once connected and otherwise
 * awaited a CACHED promise, clearing it on failure so the next request could
 * retry; the middleware in `server.ts` turned a rejection into
 * `503 Database temporarily unavailable`. So the 503 only ever covered a
 * database that was unreachable at COLD START, never one that died mid-life —
 * that case was, and still is, a 500 from whichever handler touched it.
 *
 * Reproduced rather than improved on, deliberately:
 *
 * - **Not a per-request `select 1`.** That would put a Postgres round trip in
 *   front of every request including those that never touch a table, and if it
 *   ever backed a load-balancer health check it would convert a brief Postgres
 *   hiccup into the whole service being marked unhealthy and pulled out.
 * - **Not a per-route or per-store guard.** After this change there is exactly
 *   one store, so machinery keyed on which one a route reads would be dead code
 *   in the same commit that introduced it.
 *
 * A real readiness endpoint is a separate decision; it is NOT this.
 */
export function ensurePostgresReachable(): Promise<void> {
  reachability ??= probe().catch((error: unknown) => {
    reachability = null;
    throw error;
  });
  return reachability;
}

/**
 * A real `select 1`, for `/health/ready` and the boot probe. False rather
 * than a throw: readiness is a yes/no, and a pool object survives a server
 * that has gone away, which is exactly the case this exists to catch.
 */
export async function checkPostgresHealth(): Promise<boolean> {
  if (!handle) return false;
  try {
    await handle.ping();
    return true;
  } catch {
    return false;
  }
}

/** The raw client (either driver), for the migration-ledger check at boot. */
export function getPostgresClient(): RawSqlClient {
  if (!handle) {
    throw new Error('Postgres is not connected — call connectPostgres() during startup');
  }
  return handle.client;
}

export async function closePostgres(): Promise<void> {
  reachability = null;
  if (!handle) return;
  await handle.close();
  handle = null;
}

export { schema };
