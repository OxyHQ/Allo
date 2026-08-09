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

export async function closePostgres(): Promise<void> {
  if (!handle) return;
  await handle.client.end();
  handle = null;
}

export { schema };
