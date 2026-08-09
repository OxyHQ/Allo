/**
 * The Postgres handle for this service.
 *
 * Built through `createDatabase()` from `@oxyhq/db` rather than a local
 * `drizzle(postgres(url))`, because that is what guarantees the handle carries
 * `DATABASE_CASING` — so what queries REFERENCE matches what the migrations
 * CREATED. Getting that wrong produces `column "oxyUserId" does not exist` at
 * runtime against a schema that looks correct in the editor.
 */

import { createDatabase, type OxyDatabase } from "@oxyhq/db";
import type postgres from "postgres";
import * as schema from "./schema";

export type AlloDatabase = OxyDatabase<typeof schema>;

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
 * service's database, not of one domain: a bridges or messaging repository that
 * needs a transaction handle would otherwise have to import a type out of
 * `db/moderation/`, which reads as a dependency it does not have, or declare its
 * own — and two spellings of one handle can disagree about what a transaction
 * is.
 */
export type AlloTransaction = Parameters<Parameters<AlloDatabase["transaction"]>[0]>[0];

/** What a repository accepts: the pool, or a live transaction. */
export type AlloDatabaseOrTransaction = AlloDatabase | AlloTransaction;

let handle: { db: AlloDatabase; client: postgres.Sql } | null = null;

/**
 * Open the pool. Not lazy: a bad `DATABASE_URL` should fail at boot rather than
 * on the first request that happens to touch a table.
 */
export function connectPostgres(databaseUrl: string): AlloDatabase {
  if (handle) return handle.db;
  handle = createDatabase({ databaseUrl, schema });
  return handle.db;
}

export function getDb(): AlloDatabase {
  if (!handle) {
    throw new Error("Postgres is not connected — call connectPostgres() during startup");
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
    throw new Error("Postgres is not connected — call connectPostgres() during startup");
  }
  await handle.client`select 1`;
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

export async function closePostgres(): Promise<void> {
  reachability = null;
  if (!handle) return;
  await handle.client.end();
  handle = null;
}

export { schema };
