/**
 * `account_presence` — when each account was last connected.
 *
 * Two operations and no more: write one account's last seen, and read a set of
 * them. The set read is what a watch set needs, so it takes the whole list
 * rather than being called in a loop.
 *
 * Writes converge rather than compare: two instances of one account
 * disconnecting in the same second both write, and the later timestamp wins by
 * `greatest()` in the statement rather than by a read the caller has to hold a
 * lock for.
 */

import { inArray, sql } from "drizzle-orm";
import type { AlloDatabaseOrTransaction } from "../index";
import { accountPresence } from "../schema/presence";

/**
 * Record that `accountId` was connected at `at`, keeping whichever is later.
 *
 * The caller decides how often this is worth writing — see
 * `PRESENCE_LAST_SEEN_RESOLUTION_MS`; a heartbeat every thirty seconds does
 * not need a row write every thirty seconds.
 */
export async function touchLastSeen(db: AlloDatabaseOrTransaction, accountId: string, at: Date): Promise<void> {
  await db
    .insert(accountPresence)
    .values({ accountId, lastSeenAt: at, updatedAt: at })
    .onConflictDoUpdate({
      target: accountPresence.accountId,
      set: {
        lastSeenAt: sql`greatest(${accountPresence.lastSeenAt}, excluded.last_seen_at)`,
        updatedAt: at,
      },
    });
}

/** The last seen of each of these accounts that has one. */
export async function lastSeenOf(
  db: AlloDatabaseOrTransaction,
  accountIds: readonly string[],
): Promise<Map<string, Date>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db
    .select({ accountId: accountPresence.accountId, lastSeenAt: accountPresence.lastSeenAt })
    .from(accountPresence)
    .where(inArray(accountPresence.accountId, [...accountIds]));
  return new Map(rows.map((row) => [row.accountId, row.lastSeenAt]));
}
