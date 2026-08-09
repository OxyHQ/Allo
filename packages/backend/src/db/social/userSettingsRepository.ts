/**
 * `user_settings` — the four Mongoose sub-documents, FLATTENED into columns.
 *
 * Ported from `utils/userSettings.ts`'s `ensureUserSettings` and the
 * `PUT /api/profile/settings` handler. Both change shape here, and both change
 * because the flattening moved work out of application code:
 *
 * - **`ensureUserSettings` loses a branch.** Mongoose's version had a second
 *   repair path — "the row exists but has no `profileCustomization`, so write
 *   the defaults into it" — because a sub-document with no value stored has no
 *   defaults either. `profile_cover_photo_enabled` and
 *   `profile_minimalist_mode` are `NOT NULL DEFAULT true/false` columns, so the
 *   state that branch repaired is now unrepresentable. Deleting it is the port
 *   working, not a behaviour the port dropped.
 *
 * - **An update is an explicit column list.** The Mongoose handler built a
 *   `$set` of dot-paths from request fields; the equivalent here is
 *   {@link UPDATABLE_USER_SETTINGS_COLUMNS}, an allow-list that omits `id`,
 *   `oxyUserId` and `createdAt` — so no patch, however it was constructed, can
 *   move a settings row to another user or rewrite when it was created.
 *
 * ## The defaults are the schema's, and they are asymmetric on purpose
 *
 * `security_cloud_sync_enabled` defaults FALSE while `security_encryption_...`
 * and `security_peer_to_peer_...` default TRUE. That asymmetry is the product's
 * device-first stance: cloud sync is opt-IN. Nothing in this module writes a
 * security column unless a caller explicitly asked for it — in particular
 * {@link ensureUserSettings} inserts `{id, oxyUserId}` and lets the server apply
 * every default, rather than "normalising" a new row with a literal it could get
 * wrong in exactly the direction that turns cloud sync on for somebody.
 */

import { eq } from "drizzle-orm";
import { uuidv7 } from "@oxyhq/db";
import type { AlloDatabase } from "../index";
import { userSettings } from "../schema/social";

/** A settings row as stored. No column is protected, so this is the whole row. */
export type UserSettingsRow = typeof userSettings.$inferSelect;

/**
 * Every column a caller may set, named individually.
 *
 * This is the allow-list, and it is one tuple rather than a type beside a
 * runtime list: {@link UserSettingsPatch} is derived from it and
 * {@link pickUpdatableColumns} iterates it, so the compile-time and runtime
 * halves cannot drift. `__tests__/db/social.realdb.test.ts` asserts it against
 * the real drizzle table — a column added to the schema and forgotten here
 * fails the suite rather than becoming quietly unsettable.
 *
 * `id`, `oxyUserId`, `createdAt` and `updatedAt` are absent deliberately. The
 * first three are identity and history; `updatedAt` is maintained by
 * {@link updateUserSettings} itself and must not be something a caller supplies.
 */
export const UPDATABLE_USER_SETTINGS_COLUMNS = [
  "appearanceThemeMode",
  "appearancePrimaryColor",
  "profileHeaderImage",
  "privacyProfileVisibility",
  "privacyShowContactInfo",
  "privacyAllowTags",
  "privacyAllowAllos",
  "privacyShowOnlineStatus",
  "privacyHideLikeCounts",
  "privacyHideShareCounts",
  "privacyHideReplyCounts",
  "privacyHideSaveCounts",
  "privacyHiddenWords",
  "privacyRestrictedUsers",
  "profileCoverPhotoEnabled",
  "profileMinimalistMode",
  "profileDisplayName",
  "profileCoverImage",
  "securityCloudSyncEnabled",
  "securityEncryptionEnabled",
  "securityPeerToPeerEnabled",
] as const;

export type UpdatableUserSettingsColumn = (typeof UPDATABLE_USER_SETTINGS_COLUMNS)[number];

/**
 * A partial settings update.
 *
 * Absent (`undefined`) means "leave this column alone"; `null` on a nullable
 * column means "clear it", which is how the route's
 * `appearance.primaryColor === null` case survives the port. The two closed sets
 * arrive already narrowed by the column's own `enum`, and the CHECK rendered
 * from the same tuple catches anything that reaches the server anyway.
 */
export type UserSettingsPatch = Partial<
  Pick<typeof userSettings.$inferInsert, UpdatableUserSettingsColumn>
>;

/**
 * Copy one allow-listed key, if the caller supplied it.
 *
 * Generic in the key so `target[key] = value` is checked against that column's
 * own type rather than the union of all of them — which is what makes the loop
 * below type-safe without a cast.
 */
function copyIfPresent<K extends UpdatableUserSettingsColumn>(
  target: UserSettingsPatch,
  source: UserSettingsPatch,
  key: K,
): void {
  const value = source[key];
  if (value !== undefined) target[key] = value;
}

/**
 * The allow-list applied: an object whose keys can only ever come from
 * {@link UPDATABLE_USER_SETTINGS_COLUMNS}.
 *
 * This — not the type — is what makes an unexpected key harmless. TypeScript's
 * excess-property check only fires on object literals, so a `UserSettingsPatch`
 * that reached this function through a variable can carry anything at runtime;
 * the loop never reads a key it was not told about, so nothing else can survive
 * into the statement.
 */
function pickUpdatableColumns(patch: UserSettingsPatch): UserSettingsPatch {
  const set: UserSettingsPatch = {};
  for (const column of UPDATABLE_USER_SETTINGS_COLUMNS) copyIfPresent(set, patch, column);
  return set;
}

async function readUserSettings(
  db: AlloDatabase,
  oxyUserId: string,
): Promise<UserSettingsRow | null> {
  const rows = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.oxyUserId, oxyUserId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The user's settings, creating a row of pure defaults if there is none.
 *
 * Read first, because a settings row usually already exists and the read is the
 * cheap path. The insert converges on `user_settings_oxy_user_id_key` rather
 * than trusting the read: two concurrent first requests from one user both see
 * nothing, and the unique constraint decides which one inserts. The loser
 * re-reads — `ON CONFLICT DO NOTHING` returns no row, and the winner's row is
 * committed by then — so both callers get the same settings and neither errors.
 *
 * Deliberately NOT `ON CONFLICT DO UPDATE`. That would return the row in both
 * branches and save a query, at the cost of writing a new tuple version on
 * every read of an existing row — moving `updated_at` and `xmin` for a call
 * that changed nothing.
 */
export async function ensureUserSettings(
  db: AlloDatabase,
  oxyUserId: string,
): Promise<UserSettingsRow> {
  const existing = await readUserSettings(db, oxyUserId);
  if (existing) return existing;

  const inserted = await db
    .insert(userSettings)
    .values({ id: uuidv7(), oxyUserId })
    .onConflictDoNothing({ target: userSettings.oxyUserId })
    .returning();
  const created = inserted[0];
  if (created) return created;

  const raced = await readUserSettings(db, oxyUserId);
  if (!raced) {
    throw new Error(
      "user_settings insert conflicted but no row was found — the unique constraint " +
        "on oxy_user_id is missing or the row was deleted mid-call",
    );
  }
  return raced;
}

/**
 * Apply a partial update, creating the row if there is none, and return the
 * result. The upsert is what preserves Mongoose's `{ upsert: true, new: true }`.
 *
 * An empty patch is not a degenerate case to reject: the route builds its patch
 * from whichever request fields validated, so "nothing recognised" is reachable,
 * and Mongo answered it by upserting and returning the current document.
 * {@link ensureUserSettings} is that answer, and it is also the only correct
 * one — `ON CONFLICT DO UPDATE SET` needs at least one assignment.
 *
 * `updatedAt` is set explicitly rather than left to the column's `$onUpdate`
 * hook, because whether an ORM applies that hook inside a conflict branch is
 * the ORM's decision to change; `schema/CONVENTIONS.md` makes maintaining this
 * column the application's job, so the application does it where it can be read.
 */
export async function updateUserSettings(
  db: AlloDatabase,
  oxyUserId: string,
  patch: UserSettingsPatch,
): Promise<UserSettingsRow> {
  const set = pickUpdatableColumns(patch);
  if (Object.keys(set).length === 0) return ensureUserSettings(db, oxyUserId);

  const rows = await db
    .insert(userSettings)
    // `set` is the allow-list's own output, so spreading it here can introduce
    // no column `pickUpdatableColumns` did not name.
    .values({ id: uuidv7(), oxyUserId, ...set })
    .onConflictDoUpdate({
      target: userSettings.oxyUserId,
      set: { ...set, updatedAt: new Date() },
    })
    .returning();

  const row = rows[0];
  if (!row) {
    throw new Error("user_settings upsert returned no row");
  }
  return row;
}
