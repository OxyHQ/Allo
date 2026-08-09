/**
 * `restricts` — one direction of a restriction, `userId` restricts
 * `restrictedId`.
 *
 * Ported from the three `Restrict` call sites in `routes/profileSettings.ts`.
 * The reasoning behind each statement is stated once, in `blockRepository.ts`:
 * the two tables are deliberately separate and identical, so this module is
 * deliberately its twin rather than a call into a shared generic.
 *
 * The one thing NOT to conclude from that: `restricts` is not the same fact as
 * `user_settings.privacy_restricted_users`. That column is a `text[]` the PUT
 * settings route overwrites wholesale; this table is the row-per-relation the
 * `/restricts` endpoints maintain, with its own unique index and its own
 * `created_at`. Mongo carried both too, and nothing reconciles them — porting
 * them into one place would be a behaviour change, not a cleanup.
 */

import { and, desc, eq } from "drizzle-orm";
import { uuidv7 } from "@oxyhq/db";
import type { AlloDatabase } from "../index";
import { restricts } from "../schema/social";

/** The pair naming one direction of a restriction. An object because both are `string`. */
export interface RestrictPair {
  readonly userId: string;
  readonly restrictedId: string;
}

/** The ids `userId` has restricted, newest first. See `listBlockedUserIds` for the ordering. */
export async function listRestrictedUserIds(
  db: AlloDatabase,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ restrictedId: restricts.restrictedId })
    .from(restricts)
    .where(eq(restricts.userId, userId))
    .orderBy(desc(restricts.createdAt), desc(restricts.id));
  return rows.map((row) => row.restrictedId);
}

/**
 * Restrict `restrictedId`. Returns whether this call is what created the row,
 * converging on `restricts_user_id_restricted_id_key` rather than reading first.
 */
export async function restrictUser(db: AlloDatabase, pair: RestrictPair): Promise<boolean> {
  const inserted = await db
    .insert(restricts)
    .values({ id: uuidv7(), userId: pair.userId, restrictedId: pair.restrictedId })
    .onConflictDoNothing({ target: [restricts.userId, restricts.restrictedId] })
    .returning({ id: restricts.id });
  return inserted.length > 0;
}

/** Remove a restriction. Returns whether a row existed to remove. */
export async function unrestrictUser(db: AlloDatabase, pair: RestrictPair): Promise<boolean> {
  const deleted = await db
    .delete(restricts)
    .where(and(eq(restricts.userId, pair.userId), eq(restricts.restrictedId, pair.restrictedId)))
    .returning({ id: restricts.id });
  return deleted.length > 0;
}
