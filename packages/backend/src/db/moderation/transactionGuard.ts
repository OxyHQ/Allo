/**
 * Refusing the root connection where a TRANSACTION was required.
 *
 * ## What this replaces, and why a type is not enough
 *
 * Under Mongo the invariant was `session.inTransaction()`, and
 * `ModerationOutboxService` explains at length why the TYPE alone could not carry
 * it: a required `ClientSession` parameter is satisfied by any session, including
 * a bare `startSession()` nobody opened a transaction on, which type-checks
 * perfectly and commits the row on its own.
 *
 * Drizzle has the same hole and a wider one. The root handle and a transaction
 * handle are both accepted wherever `AlloDatabaseOrTransaction` is asked for — so
 * `enqueueModerationOutboxEvent(input, getDb())` compiles, runs, commits the row
 * alone, and passes any test that only asserts the row exists. It is also what
 * FORGETTING an argument gets you, everywhere a repository defaults its `db`
 * parameter to `getDb()`, which is the shape of the mistake worth catching: it
 * looks exactly like correct code and fails as lost moderation work on the day
 * something restarts between the two writes.
 *
 * ## The discriminator
 *
 * The root database has no `rollback`; a transaction handle's `rollback` IS a
 * function — for a nested (savepoint) transaction too, which is what makes this
 * safe inside a caller that already opened one. `rollback` is the method a
 * transaction has BECAUSE it is one, so this tests what the handle can DO rather
 * than a name that happens to differ.
 *
 * `instanceof PgTransaction` was the alternative and is worse here: it holds only
 * while exactly one copy of drizzle is installed, which is a property of the
 * installer's hoisting rather than of this code — and bun's linker modes put
 * packages in different places, so it is not even a stable property of this repo.
 *
 * ## Which writes are guarded, and which deliberately are not
 *
 * Two: {@link import('./moderationOutboxRepository').enqueueModerationOutboxEvent}
 * and {@link import('./moderationEventRepository').markModerationEventQueued}.
 * Each is one half of a pair that must commit together, and each is the half whose
 * absence is silent. Nothing else here is guarded — a report stored for a type Allo
 * never delivers has no second write to commit with, and a guard on it would be a
 * restriction the port invented rather than one it preserved.
 */

import type { AlloDatabaseOrTransaction, AlloTransaction } from "../index";

/**
 * Raised when a write that must commit with its domain row is handed the root
 * connection.
 *
 * Never expected at runtime — it exists so the invariant is ENFORCED rather than
 * reviewed.
 */
export class MissingTransactionError extends Error {
  constructor(operation: string) {
    super(
      `Refusing to run '${operation}' outside a transaction: it must commit together ` +
        "with the write it belongs to, or a report is answered 201 and never delivered. " +
        "Pass the handle from `db.transaction(...)`, not `getDb()`.",
    );
    this.name = "MissingTransactionError";
  }
}

/**
 * Narrow a handle to a transaction, or throw.
 *
 * @param operation Names the CALL, not just the function — the callers pass the
 *   event id too, so a refusal says which enqueue was misrouted instead of sending
 *   whoever hits it hunting through every caller.
 * @throws {MissingTransactionError} When handed the root connection.
 */
export function requireTransaction(
  db: AlloDatabaseOrTransaction,
  operation: string,
): AlloTransaction {
  if (!("rollback" in db) || typeof db.rollback !== "function") {
    throw new MissingTransactionError(operation);
  }
  return db;
}
