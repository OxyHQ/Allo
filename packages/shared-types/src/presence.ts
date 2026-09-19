/**
 * Presence: whether an account has a device connected, and when it last did.
 *
 * Presence is METADATA. Unlike typing — an encrypted application message the
 * server only relays — the server computes this, so it is in
 * `threat-model.md` §5 as something the operator can see. What follows is
 * about limiting who ELSE can see it, because an online dot that anybody may
 * poll is a published sleep schedule, and two of them correlated is a
 * published relationship.
 *
 * Four rules, and they are enforced by the server rather than asked of the
 * client:
 *
 * 1. **Reciprocity.** An account that does not publish its own presence
 *    receives nobody else's. This is WhatsApp's rule, and it cannot be added
 *    later without taking something away from people who already have it.
 * 2. **Shared conversation.** An account may only ask about accounts it
 *    shares a conversation with. Presence is not a directory lookup.
 * 3. **Blocks cut both ways.** A blocked account sees nothing and is seen by
 *    nothing.
 * 4. **A watch set, not a broadcast.** A client says which accounts it is
 *    showing and hears about those. The server never fans out to everybody
 *    who shares any conversation with you.
 *
 * `lastSeenAt` is truncated to the minute. A second-accurate last seen is a
 * better tracking signal than the dot itself.
 */
import { z } from "zod";
import { accountIdSchema, isoDateSchema } from "./common";

/** How many accounts one client may watch at once — a screen, not an address book. */
export const MAX_PRESENCE_WATCH = 200;

/** How stale an account's heartbeat may be before it counts as offline. */
export const PRESENCE_TTL_MS = 75_000;
/** How often a connected client refreshes its heartbeat. Comfortably inside the TTL. */
export const PRESENCE_HEARTBEAT_MS = 30_000;
/** The resolution `lastSeenAt` is published at. */
export const PRESENCE_LAST_SEEN_RESOLUTION_MS = 60_000;

/**
 * One account's presence as the asker is allowed to see it.
 *
 * `online: false, lastSeenAt: null` is the answer for an account that hides
 * its presence, one that has blocked the asker, and one that is simply
 * offline and has never been seen. The three are deliberately identical: a
 * client that could tell them apart could tell whether it had been blocked.
 */
export const presenceStateSchema = z.object({
  accountId: accountIdSchema,
  online: z.boolean(),
  lastSeenAt: isoDateSchema.nullable(),
});
export type PresenceState = z.infer<typeof presenceStateSchema>;

/** `GET /v1/presence?accountIds=a,b,c` — the state of a watch set, at once. */
export const presenceQuerySchema = z.object({
  accountIds: z
    .string()
    .transform((value) => value.split(",").filter((id) => id.length > 0))
    .pipe(z.array(accountIdSchema).min(1).max(MAX_PRESENCE_WATCH)),
});
export type PresenceQuery = z.infer<typeof presenceQuerySchema>;

export const presenceResponseSchema = z.object({
  presence: z.array(presenceStateSchema),
  /**
   * Whether the asker publishes its own presence. `false` means every state
   * above is the hidden answer, and the app should say why rather than
   * drawing everybody as offline.
   */
  publishing: z.boolean(),
});
export type PresenceResponse = z.infer<typeof presenceResponseSchema>;

/**
 * Client → server: the accounts this client is showing. Replaces the previous
 * set for that socket; an empty list stops the updates.
 */
export const presenceWatchEventSchema = z.object({
  accountIds: z.array(accountIdSchema).max(MAX_PRESENCE_WATCH),
});
export type PresenceWatchEvent = z.infer<typeof presenceWatchEventSchema>;

/**
 * Client → server: this instance is still here. The socket being open is not
 * enough — a socket survives a sleeping phone, and an account that is asleep
 * is not online.
 */
export const presenceHeartbeatEventSchema = z.object({});
export type PresenceHeartbeatEvent = z.infer<typeof presenceHeartbeatEventSchema>;
