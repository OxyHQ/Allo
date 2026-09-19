/**
 * Last seen, and nothing else.
 *
 * Whether an account is online RIGHT NOW is not here: that is a heartbeat with
 * a seventy-five second life, it changes constantly, and it belongs in Redis
 * (`runtime/presenceStore.ts`), which is where it is. Postgres holds only the
 * one fact that has to survive a restart of everything — when the account was
 * last connected — because an account that was online yesterday and is offline
 * now is not the same as one that has never been seen, and a client cannot
 * tell those apart from an empty cache.
 *
 * `last_seen_at` is written coarsely on purpose: at most once a minute per
 * account, and published truncated to the minute
 * (`PRESENCE_LAST_SEEN_RESOLUTION_MS`). A second-accurate last seen is a
 * better tracking signal than the online dot it sits beside, and nothing in
 * the product needs the precision.
 *
 * No foreign key on `account_id`: Oxy owns identity, as everywhere else in
 * this schema (`CONVENTIONS.md`).
 */

import { pgTable, text } from "drizzle-orm/pg-core";
import { timestamptz, updatedAt } from "@oxy.so/db";

export const accountPresence = pgTable("account_presence", {
  /** The Oxy account. One row per account, written by whichever instance beat last. */
  accountId: text().primaryKey(),
  /** When any instance of the account was last connected. */
  lastSeenAt: timestamptz().notNull(),
  updatedAt: updatedAt(),
});
