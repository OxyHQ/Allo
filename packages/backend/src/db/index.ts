/**
 * The Postgres handle for this service.
 *
 * Built through `createDatabase()` from `@oxyhq/db` rather than a local
 * `drizzle(postgres(url))`, because that is what guarantees the handle carries
 * `DATABASE_CASING` — so what queries REFERENCE matches what the migrations
 * CREATED. Getting that wrong produces `column "oxyUserId" does not exist` at
 * runtime against a schema that looks correct in the editor.
 *
 * Nothing imports this yet. The foundation lands the destination; the call-site
 * port is a separate change, so this file has no behaviour to break.
 */

import { createDatabase, type OxyDatabase } from "@oxyhq/db";
import type postgres from "postgres";
import * as schema from "./schema";

export type AlloDatabase = OxyDatabase<typeof schema>;

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
