/**
 * The `user_settings` wire shape, both directions.
 *
 * The table is FLAT (`privacy_show_contact_info`, `security_cloud_sync_enabled`,
 * …) because `schema/social.ts` refused to store four Mongoose sub-documents as
 * opaque `jsonb`. The API is NESTED, because that is what Mongo emitted and what
 * every client reads today — `stores/appearanceStore.ts` reads
 * `appearance.primaryColor` and `profileCustomization.coverImage`,
 * `lib/privacy/api.ts` reads `privacy.hiddenWords`, `lib/security/cloudSync.ts`
 * reads `security.cloudSyncEnabled`.
 *
 * So the flattening stops here. This module is the ONE place the two shapes meet:
 * {@link toUserSettingsDto} projects a row outward and
 * {@link readUserSettingsPatch} reads a request inward. Splitting them across the
 * route and the repository is how one direction gains a field the other never
 * learns about.
 *
 * ## `null` is OMITTED, not emitted
 *
 * Mongo stored an absent optional as a missing path, so the JSON simply had no
 * `primaryColor` key. Postgres stores it as `NULL`, and `null` is a value that
 * survives `JSON.stringify`. Emitting it would be a wire change: the settings
 * screen spreads `...mySettings.profileCustomization` straight back into its next
 * PUT, so a `coverImage: null` that was previously absent would start arriving as
 * an explicit "clear this" on every save. Omitting keeps the round trip identical.
 *
 * ## What is deliberately NOT emitted
 *
 * `_id`. Mongo put one on every document and nothing in this repository reads it
 * — not the settings screen, not the appearance store, not the privacy or cloud
 * sync clients, which key everything on `oxyUserId`. The row's real primary key
 * is emitted as `id`; inventing an `_id` alias for a value no client asks for
 * would be a compatibility shim for a reader that does not exist.
 */

import type { UserSettingsRow, UserSettingsPatch } from "../db/social/userSettingsRepository";
import { PROFILE_VISIBILITIES, THEME_MODES } from "../db/schema/social";

/**
 * The nested document a client receives.
 *
 * Written out rather than derived from the row type: this is a CONTRACT with
 * shipped mobile builds, and a type that follows the table automatically would
 * let a column rename travel silently onto the wire.
 */
export interface UserSettingsDto {
  readonly id: string;
  readonly oxyUserId: string;
  readonly appearance: { themeMode: string; primaryColor?: string };
  readonly profileHeaderImage?: string;
  readonly privacy: {
    profileVisibility: string;
    showContactInfo: boolean;
    allowTags: boolean;
    allowallos: boolean;
    showOnlineStatus: boolean;
    hideLikeCounts: boolean;
    hideShareCounts: boolean;
    hideReplyCounts: boolean;
    hideSaveCounts: boolean;
    hiddenWords: string[];
    restrictedUsers: string[];
  };
  readonly profileCustomization: {
    coverPhotoEnabled: boolean;
    minimalistMode: boolean;
    displayName?: string;
    coverImage?: string;
  };
  readonly security: {
    cloudSyncEnabled: boolean;
    encryptionEnabled: boolean;
    peerToPeerEnabled: boolean;
  };
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Spread helper: `{...optional('primaryColor', value)}` contributes nothing when null. */
function optional<K extends string>(key: K, value: string | null): { [P in K]?: string } {
  return value === null ? ({} as { [P in K]?: string }) : ({ [key]: value } as { [P in K]?: string });
}

/** One stored row as the API has always presented it. */
export function toUserSettingsDto(row: UserSettingsRow): UserSettingsDto {
  return {
    id: row.id,
    oxyUserId: row.oxyUserId,
    appearance: {
      themeMode: row.appearanceThemeMode,
      ...optional("primaryColor", row.appearancePrimaryColor),
    },
    ...optional("profileHeaderImage", row.profileHeaderImage),
    privacy: {
      profileVisibility: row.privacyProfileVisibility,
      showContactInfo: row.privacyShowContactInfo,
      allowTags: row.privacyAllowTags,
      allowallos: row.privacyAllowAllos,
      showOnlineStatus: row.privacyShowOnlineStatus,
      hideLikeCounts: row.privacyHideLikeCounts,
      hideShareCounts: row.privacyHideShareCounts,
      hideReplyCounts: row.privacyHideReplyCounts,
      hideSaveCounts: row.privacyHideSaveCounts,
      hiddenWords: row.privacyHiddenWords,
      restrictedUsers: row.privacyRestrictedUsers,
    },
    profileCustomization: {
      coverPhotoEnabled: row.profileCoverPhotoEnabled,
      minimalistMode: row.profileMinimalistMode,
      ...optional("displayName", row.profileDisplayName),
      ...optional("coverImage", row.profileCoverImage),
    },
    security: {
      cloudSyncEnabled: row.securityCloudSyncEnabled,
      encryptionEnabled: row.securityEncryptionEnabled,
      peerToPeerEnabled: row.securityPeerToPeerEnabled,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A request body is `unknown`; this is how one nested group is reached safely. */
function group(body: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = body[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function bool(source: Record<string, unknown>, key: string): boolean | undefined {
  const value = source[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A string field that a client may also CLEAR by sending `null`.
 *
 * Three outcomes, and the third is the one worth naming: `undefined` leaves the
 * column alone, `null` clears it, and an empty-after-trim string ALSO clears it —
 * which is what the Mongoose handler did (`value.trim() || undefined` inside a
 * `$set`), so a user who blanks the display-name field gets it cleared rather
 * than set to `""`.
 */
function clearableString(source: Record<string, unknown>, key: string): string | null | undefined {
  const value = source[key];
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  return value.trim() || null;
}

/** Only strings survive: a `hiddenWords` carrying a number must not reach a `text[]`. */
function stringArray(source: Record<string, unknown>, key: string): string[] | undefined {
  const value = source[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function oneOf<T extends string>(
  source: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = source[key];
  return allowed.find((candidate) => candidate === value);
}

/**
 * The recognised fields of a `PUT /api/profile/settings` body, as a column patch.
 *
 * Unrecognised keys and wrongly-typed values are DROPPED rather than refused,
 * which is what the Mongoose handler did — it built a `$set` from whichever
 * fields passed their `typeof` check and ignored the rest. Preserving that is
 * deliberate: several app versions are in the field at once and a newer one
 * sending a field this server does not know must not have its whole save fail.
 *
 * The result can be empty; `updateUserSettings` answers that by returning the
 * current row, exactly as the upsert did.
 */
export function readUserSettingsPatch(body: unknown): UserSettingsPatch {
  if (typeof body !== "object" || body === null) return {};
  const root = body as Record<string, unknown>;
  const patch: UserSettingsPatch = {};

  const appearance = group(root, "appearance");
  if (appearance) {
    const themeMode = oneOf(appearance, "themeMode", THEME_MODES);
    if (themeMode !== undefined) patch.appearanceThemeMode = themeMode;
    const primaryColor = clearableString(appearance, "primaryColor");
    if (primaryColor !== undefined) patch.appearancePrimaryColor = primaryColor;
  }

  if (typeof root.profileHeaderImage === "string") {
    // Not `clearableString`: the Mongoose handler assigned this one verbatim,
    // so `""` stored an empty string and only `""` could clear it.
    patch.profileHeaderImage = root.profileHeaderImage;
  }

  const customization = group(root, "profileCustomization");
  if (customization) {
    const coverPhotoEnabled = bool(customization, "coverPhotoEnabled");
    if (coverPhotoEnabled !== undefined) patch.profileCoverPhotoEnabled = coverPhotoEnabled;
    const minimalistMode = bool(customization, "minimalistMode");
    if (minimalistMode !== undefined) patch.profileMinimalistMode = minimalistMode;
    const displayName = clearableString(customization, "displayName");
    if (displayName !== undefined) patch.profileDisplayName = displayName;
    const coverImage = clearableString(customization, "coverImage");
    if (coverImage !== undefined) patch.profileCoverImage = coverImage;
  }

  const privacy = group(root, "privacy");
  if (privacy) {
    const profileVisibility = oneOf(privacy, "profileVisibility", PROFILE_VISIBILITIES);
    if (profileVisibility !== undefined) patch.privacyProfileVisibility = profileVisibility;

    const showContactInfo = bool(privacy, "showContactInfo");
    if (showContactInfo !== undefined) patch.privacyShowContactInfo = showContactInfo;
    const allowTags = bool(privacy, "allowTags");
    if (allowTags !== undefined) patch.privacyAllowTags = allowTags;
    const allowallos = bool(privacy, "allowallos");
    if (allowallos !== undefined) patch.privacyAllowAllos = allowallos;
    const showOnlineStatus = bool(privacy, "showOnlineStatus");
    if (showOnlineStatus !== undefined) patch.privacyShowOnlineStatus = showOnlineStatus;
    const hideLikeCounts = bool(privacy, "hideLikeCounts");
    if (hideLikeCounts !== undefined) patch.privacyHideLikeCounts = hideLikeCounts;
    const hideShareCounts = bool(privacy, "hideShareCounts");
    if (hideShareCounts !== undefined) patch.privacyHideShareCounts = hideShareCounts;
    const hideReplyCounts = bool(privacy, "hideReplyCounts");
    if (hideReplyCounts !== undefined) patch.privacyHideReplyCounts = hideReplyCounts;
    const hideSaveCounts = bool(privacy, "hideSaveCounts");
    if (hideSaveCounts !== undefined) patch.privacyHideSaveCounts = hideSaveCounts;

    const hiddenWords = stringArray(privacy, "hiddenWords");
    if (hiddenWords !== undefined) patch.privacyHiddenWords = hiddenWords;
    const restrictedUsers = stringArray(privacy, "restrictedUsers");
    if (restrictedUsers !== undefined) patch.privacyRestrictedUsers = restrictedUsers;
  }

  const security = group(root, "security");
  if (security) {
    const cloudSyncEnabled = bool(security, "cloudSyncEnabled");
    if (cloudSyncEnabled !== undefined) patch.securityCloudSyncEnabled = cloudSyncEnabled;
    const encryptionEnabled = bool(security, "encryptionEnabled");
    if (encryptionEnabled !== undefined) patch.securityEncryptionEnabled = encryptionEnabled;
    const peerToPeerEnabled = bool(security, "peerToPeerEnabled");
    if (peerToPeerEnabled !== undefined) patch.securityPeerToPeerEnabled = peerToPeerEnabled;
  }

  return patch;
}
