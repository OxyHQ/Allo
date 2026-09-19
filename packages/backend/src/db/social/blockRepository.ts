/**
 * `blocks` — one direction of a block, `userId` blocks `blockedId`.
 *
 * Ported from the three `Block` call sites in `routes/profileSettings.ts`. This
 * module is the whole surface those need and deliberately nothing more.
 *
 * ## Why this is not shared with `restrictRepository`
 *
 * `blocks` and `restricts` are separate tables with identical shape, on purpose
 * (`schema/CONVENTIONS.md`). A generic helper parameterised over "the table and
 * its target column" would express in TypeScript exactly the merge the schema
 * declined to make, and would hide the one thing worth reading here — which
 * unique index each statement converges on.
 *
 * ## Self-blocking
 *
 * `POST /blocks` refuses `userId === blockedId` with a 400. That rule is not
 * repeated here: the schema carries no CHECK for it, so a guard in this module
 * would be a SECOND application-level copy of a rule the database does not
 * enforce, in a layer that cannot produce the 400 the caller needs.
 */

import { and, desc, eq, inArray, or } from "drizzle-orm";
import { uuidv7 } from "@oxy.so/db";
import type { AlloDatabase } from "../index";
import { blocks } from "../schema/social";

/** The pair naming one direction of a block. An object because both are `string`. */
export interface BlockPair {
  readonly userId: string;
  readonly blockedId: string;
}

/**
 * The ids `userId` has blocked, newest first.
 *
 * Only the id is selected because that is all `GET /blocks` returns — it maps
 * the rows to `blockedId` and discards the rest.
 *
 * `id` is a tiebreaker, not decoration: `created_at` is truncated to
 * milliseconds, so two rows written in the same millisecond have no order at
 * all under `created_at` alone and Postgres is free to return them differently
 * on each call. A uuid v7 is time-ordered, so descending `id` continues the
 * intent of descending `created_at` rather than cutting across it.
 */
export async function listBlockedUserIds(db: AlloDatabase, userId: string): Promise<string[]> {
  const rows = await db
    .select({ blockedId: blocks.blockedId })
    .from(blocks)
    .where(eq(blocks.userId, userId))
    .orderBy(desc(blocks.createdAt), desc(blocks.id));
  return rows.map((row) => row.blockedId);
}

/**
 * Which of `others` are on either side of a block with `userId`.
 *
 * Both directions in one query, because for everything a block is meant to
 * stop — a ring, a status update, an online dot — the direction does not
 * matter. Somebody who blocked you must not be reachable BY you either, or
 * blocking them tells them they were blocked.
 */
export async function blockedEitherWay(
  db: AlloDatabase,
  userId: string,
  others: readonly string[],
): Promise<Set<string>> {
  if (others.length === 0) return new Set();
  const rows = await db
    .select({ userId: blocks.userId, blockedId: blocks.blockedId })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.userId, userId), inArray(blocks.blockedId, [...others])),
        and(eq(blocks.blockedId, userId), inArray(blocks.userId, [...others])),
      ),
    );
  const cut = new Set<string>();
  for (const row of rows) cut.add(row.userId === userId ? row.blockedId : row.userId);
  return cut;
}

/**
 * Block `blockedId`. Returns whether this call is what created the block.
 *
 * ONE statement, converging on `blocks_user_id_blocked_id_key`. The Mongoose
 * version read first and inserted second, with a duplicate-key `catch` behind
 * it as a net; between that read and that write two concurrent requests could
 * both see nothing and both insert. The unique index is what makes the
 * duplicate impossible, and `ON CONFLICT DO NOTHING` is what turns losing that
 * race into the correct answer instead of an error to classify.
 *
 * The empty vs. one-row `RETURNING` set IS the "already blocked" answer, which
 * is why `POST /blocks` can keep telling 201 from 200 without a second query. A
 * genuine failure — a dropped connection, an exhausted pool — still throws,
 * rather than being read as a duplicate the way a `catch` on the insert would.
 */
export async function blockUser(db: AlloDatabase, pair: BlockPair): Promise<boolean> {
  const inserted = await db
    .insert(blocks)
    .values({ id: uuidv7(), userId: pair.userId, blockedId: pair.blockedId })
    .onConflictDoNothing({ target: [blocks.userId, blocks.blockedId] })
    .returning({ id: blocks.id });
  return inserted.length > 0;
}

/**
 * Remove a block. Returns whether a row existed to remove — `DELETE /blocks/:id`
 * answers 404 when it did not, so the caller needs to tell the two apart.
 */
export async function unblockUser(db: AlloDatabase, pair: BlockPair): Promise<boolean> {
  const deleted = await db
    .delete(blocks)
    .where(and(eq(blocks.userId, pair.userId), eq(blocks.blockedId, pair.blockedId)))
    .returning({ id: blocks.id });
  return deleted.length > 0;
}
