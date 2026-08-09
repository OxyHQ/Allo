/**
 * Per-user social state: blocks, restricts, behaviour and settings.
 *
 * Ported from `models/Block.ts`, `models/Restrict.ts`, `models/UserBehavior.ts`
 * and `models/UserSettings.ts`. Decisions common to the whole schema are in
 * `CONVENTIONS.md`.
 */

import { boolean, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { createdAt, updatedAt } from "@oxyhq/db";
import { checkOneOf } from "./columns";

export const THEME_MODES = ["light", "dark", "system"] as const;
export type ThemeMode = (typeof THEME_MODES)[number];

export const PROFILE_VISIBILITIES = ["public", "private", "followers_only"] as const;
export type ProfileVisibility = (typeof PROFILE_VISIBILITIES)[number];

/**
 * One direction of a block. `userId` blocks `blockedId`.
 *
 * Both sides are Oxy user ids — a foreign SERVICE's primary key — so neither
 * carries a foreign key. Oxy owns identity; a FK here would claim this database
 * can answer whether a person exists, which it cannot.
 */
export const blocks = pgTable(
  "blocks",
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    blockedId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("blocks_user_id_blocked_id_key").on(t.userId, t.blockedId),
    index("blocks_blocked_id_idx").on(t.blockedId),
  ],
);

/** The same shape as {@link blocks}, and deliberately its own table. */
export const restricts = pgTable(
  "restricts",
  {
    id: text().primaryKey(),
    userId: text().notNull(),
    restrictedId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("restricts_user_id_restricted_id_key").on(t.userId, t.restrictedId),
    index("restricts_restricted_id_idx").on(t.restrictedId),
  ],
);

/**
 * `preferences` was `Schema.Types.Mixed` with no declared shape and no reader
 * that projects a field out of it, so it stays opaque rather than being invented
 * into columns during a port. `jsonb` here records that the shape is genuinely
 * unknown; guessing one would produce columns no writer fills.
 */
export const userBehaviors = pgTable("user_behaviors", {
  id: text().primaryKey(),
  oxyUserId: text().notNull().unique("user_behaviors_oxy_user_id_key"),
  preferences: jsonb().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * The four embedded settings documents, FLATTENED into columns.
 *
 * Mongoose nested them for grouping, not because anything reads them whole, and
 * every leaf is a scalar with a declared default. As `jsonb` those defaults
 * would live only in application code and the two closed value sets
 * (`themeMode`, `profileVisibility`) could hold anything at all. The prefix in
 * each column name preserves which document a setting came from.
 *
 * `hiddenWords` and `restrictedUsers` stay `text[]`: they are unordered sets of
 * opaque strings with no per-element state, so a child table would add two joins
 * and a sequence for nothing.
 */
export const userSettings = pgTable(
  "user_settings",
  {
    id: text().primaryKey(),
    oxyUserId: text().notNull().unique("user_settings_oxy_user_id_key"),

    appearanceThemeMode: text({ enum: THEME_MODES }).notNull().default("system"),
    appearancePrimaryColor: text(),

    profileHeaderImage: text(),

    privacyProfileVisibility: text({ enum: PROFILE_VISIBILITIES }).notNull().default("public"),
    privacyShowContactInfo: boolean().notNull().default(true),
    privacyAllowTags: boolean().notNull().default(true),
    privacyAllowAllos: boolean().notNull().default(true),
    privacyShowOnlineStatus: boolean().notNull().default(true),
    privacyHideLikeCounts: boolean().notNull().default(false),
    privacyHideShareCounts: boolean().notNull().default(false),
    privacyHideReplyCounts: boolean().notNull().default(false),
    privacyHideSaveCounts: boolean().notNull().default(false),
    privacyHiddenWords: text().array().notNull().default([]),
    privacyRestrictedUsers: text().array().notNull().default([]),

    profileCoverPhotoEnabled: boolean().notNull().default(true),
    profileMinimalistMode: boolean().notNull().default(false),
    profileDisplayName: text(),
    profileCoverImage: text(),

    /** Device-first: cloud sync is opt-IN, encryption and P2P are opt-OUT. */
    securityCloudSyncEnabled: boolean().notNull().default(false),
    securityEncryptionEnabled: boolean().notNull().default(true),
    securityPeerToPeerEnabled: boolean().notNull().default(true),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf("user_settings_appearance_theme_mode_check", t.appearanceThemeMode, THEME_MODES),
    checkOneOf(
      "user_settings_privacy_profile_visibility_check",
      t.privacyProfileVisibility,
      PROFILE_VISIBILITIES,
    ),
  ],
);
