/**
 * The schema barrel — the ONE object `createDatabase({ schema })` and
 * `drizzle-kit` are both given, so what queries reference and what migrations
 * create come from the same source.
 */

export * from "./bridges";
export * from "./conversations";
export * from "./devices";
export * from "./messages";
export * from "./moderation";
export * from "./social";
