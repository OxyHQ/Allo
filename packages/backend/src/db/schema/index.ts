/**
 * The schema barrel — the ONE object `createDatabase({ schema })` and
 * `drizzle-kit` are both given, so what queries reference and what migrations
 * create come from the same source.
 *
 * One file per domain. The messaging platform's tables (`docs/platform/`) are
 * added here as their own domain files; nothing else re-exports a table.
 */

export * from "./moderation";
export * from "./social";
