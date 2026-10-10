/**
 * Column and constraint helpers local to this schema.
 *
 * Everything general — `timestamptz`, `createdAt`/`updatedAt`, `generatedId`,
 * `inList` — belongs to `@oxy.so/db` and is imported from there, not re-declared.
 * This file holds only what that package does not own.
 */

import { sql } from "drizzle-orm";
import { check, type PgColumn } from "drizzle-orm/pg-core";
import { inList, textArrayLiteral } from "@oxy.so/db";

/**
 * `CHECK (<column> in (…))`, rendered from the SAME tuple that types the column.
 *
 * `text({ enum })` emits NO DDL — it is a TypeScript narrowing only, so a closed
 * value set written without this beside it looks constrained in the editor and
 * accepts anything in the database. Every such column in this schema states its
 * CHECK explicitly, generated from the tuple rather than retyped, so the two
 * cannot drift.
 *
 * A nullable column passes: `null in (…)` is NULL, and a CHECK rejects only
 * FALSE. That is wanted — an unset optional value is absence, not a violation.
 */
export function checkOneOf(name: string, column: PgColumn, values: readonly string[]) {
  return check(name, sql`${column} in (${sql.raw(inList(values))})`);
}

/**
 * `CHECK (<column> <@ array[…])` — every element of a `text[]` comes from a
 * closed set.
 *
 * Containment is trivially satisfied by an empty array, which is why
 * {@link checkNonEmptyArray} exists separately: "every element is in the set" and
 * "there is at least one element" are two different claims. Collapsing them into
 * one constraint would silently drop the second.
 */
export function checkArrayWithin(name: string, column: PgColumn, values: readonly string[]) {
  return check(name, sql`${column} <@ ${sql.raw(textArrayLiteral(values))}`);
}

/** `CHECK (array_length(<column>, 1) >= 1)` — the array carries at least one element. */
export function checkNonEmptyArray(name: string, column: PgColumn) {
  return check(name, sql`coalesce(array_length(${column}, 1), 0) >= 1`);
}
