/**
 * `@allo/shared-types`: the v1 wire contract of the Allo platform, as zod
 * schemas with their inferred types. The backend validates requests with
 * them; the SDK types its calls and parses answers with the same ones.
 *
 * `docs/platform/api-v1.md` is the route-by-route reference.
 */

// Primitives, error shape, base64url codec
export * from "./common";

// Client instances and enrollment
export * from "./instances";

// Request signing headers and message
export * from "./requestSigning";

// MLS key packages
export * from "./keyPackages";

// Conversations, members, leaves
export * from "./conversations";

// The event log and event submission
export * from "./events";

// The delivery stream, cursors and socket events
export * from "./sync";

// Encrypted blobs
export * from "./blobs";

// The E2EE application-message envelope (plaintext before MLS)
export * from "./appMessage";

// Legacy transport envelope + pagination, still used by the directory routes
export * from "./api";

// People directory DTOs (the Oxy lookups, projected)
export * from "./directory";
