/**
 * The schema barrel — the ONE object `createDatabase({ schema })` and
 * `drizzle-kit` are both given, so what queries reference and what migrations
 * create come from the same source.
 *
 * One file per domain. The messaging platform (`docs/platform/`) is seven of
 * them: instances, conversations, events, deliveries, blobs, history (the
 * E2EE archive offers and backups), presence (last seen), statuses and calls.
 */

export * from "./blobs";
export * from "./calls";
export * from "./conversations";
export * from "./deliveries";
export * from "./events";
export * from "./history";
export * from "./instances";
export * from "./moderation";
export * from "./presence";
export * from "./social";
export * from "./statuses";
