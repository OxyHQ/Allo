/**
 * `user_behaviors` — opaque personalization state, one row per user.
 *
 * `preferences` was `Schema.Types.Mixed` and is `jsonb` for the reason
 * `schema/CONVENTIONS.md` gives: nothing projects a field out of it. So nothing
 * here reads inside it, queries inside it, or declares a shape for it. A
 * repository is where an invented shape would first look reasonable, and where
 * it would then become the shape every later reader believes.
 *
 * ## Why this module has one function
 *
 * `DELETE /api/profile/settings/behavior` is the ONLY production call site of
 * this model in the repository — `UserBehavior.findOneAndDelete({ oxyUserId })`.
 * There is no writer and no reader anywhere in this service; whatever fills
 * `preferences` does not live here. An `upsertUserBehavior` would therefore be
 * surface nobody calls, written against a shape nobody has declared.
 */

import { eq } from "drizzle-orm";
import type { AlloDatabase } from "../index";
import { userBehaviors } from "../schema/social";

/**
 * Delete a user's personalization row. Returns whether one existed.
 *
 * The route reports "reset successfully" or "nothing to reset" from this, so
 * the distinction is the caller's, not a detail: `DELETE` alone would report
 * success for a user who never had a row.
 */
export async function deleteUserBehavior(
  db: AlloDatabase,
  oxyUserId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(userBehaviors)
    .where(eq(userBehaviors.oxyUserId, oxyUserId))
    .returning({ id: userBehaviors.id });
  return deleted.length > 0;
}
