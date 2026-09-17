/**
 * The schema barrel — the ONE object `createDatabase({ schema })` and
 * `drizzle-kit` are both given, so what queries reference and what migrations
 * create come from the same source.
 *
 * One file per domain. The messaging platform (`docs/platform/`) is five of
 * them: instances, conversations, events, deliveries and blobs.
 */

export * from "./blobs";
export * from "./conversations";
export * from "./deliveries";
export * from "./events";
export * from "./instances";
export * from "./moderation";
export * from "./social";
