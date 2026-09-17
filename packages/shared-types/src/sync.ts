/**
 * Sync: the per-instance delivery stream and the socket events around it.
 *
 * Each instance has its own stream of deliveries, ordered by a dense integer
 * the client never sees as a number: the cursor is base64url of its decimal
 * form, and a client stores it, hands it back, and compares nothing.
 */
import { z } from "zod";
import {
  accountIdSchema,
  base64Schema,
  base64UrlDecode,
  base64UrlEncode,
  conversationIdSchema,
  instanceIdSchema,
  nonNegativeIntSchema,
} from "./common";
import { conversationEventSchema } from "./events";

export const SOCKET_NAMESPACE = "/v1";

export const cursorSchema = z.base64url().min(1).max(64);
export type Cursor = z.infer<typeof cursorSchema>;

/** The cursor of the empty stream: `encodeCursor(0)`. */
export const INITIAL_CURSOR = "MA";

const ASCII = {
  encode(text: string): Uint8Array {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
    return out;
  },
  decode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return s;
  },
};

/** base64url of the decimal form of a non-negative integer. */
export function encodeCursor(n: bigint | number): string {
  if (typeof n === "number" && (!Number.isInteger(n) || n < 0)) {
    throw new RangeError("cursor must be a non-negative integer");
  }
  if (typeof n === "bigint" && n < 0n) throw new RangeError("cursor must be a non-negative integer");
  return base64UrlEncode(ASCII.encode(String(n)));
}

/** The inverse of {@link encodeCursor}. Throws `RangeError` on anything it did not produce. */
export function decodeCursor(cursor: string): bigint {
  const text = ASCII.decode(base64UrlDecode(cursor));
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new RangeError("malformed cursor");
  return BigInt(text);
}

export const syncDeliverySchema = z.object({
  /** The position of THIS delivery; acking it acks everything up to it. */
  cursor: cursorSchema,
  conversationId: conversationIdSchema,
  event: conversationEventSchema,
});
export type SyncDelivery = z.infer<typeof syncDeliverySchema>;

export const MAX_SYNC_PAGE = 500;

/** `GET /v1/sync?cursor=&limit=` — query, coerced from strings. */
export const syncQuerySchema = z.object({
  /** Return deliveries after this cursor. Absent: from the beginning of the stream. */
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SYNC_PAGE).default(100),
});
export type SyncQuery = z.infer<typeof syncQuerySchema>;

export const syncResponseSchema = z.object({
  deliveries: z.array(syncDeliverySchema),
  /** Where to resume. Equals the request cursor (or {@link INITIAL_CURSOR}) when nothing came back. */
  nextCursor: cursorSchema,
  hasMore: z.boolean(),
});
export type SyncResponse = z.infer<typeof syncResponseSchema>;

/** `POST /v1/sync/ack` */
export const ackSyncRequestSchema = z.object({
  cursor: cursorSchema,
});
export type AckSyncRequest = z.infer<typeof ackSyncRequestSchema>;

// ---------------------------------------------------------------------------
// Socket.IO events on the `/v1` namespace.
// ---------------------------------------------------------------------------

/** Server → client: something is waiting in the stream. Pull `/v1/sync`. */
export const syncNudgeEventSchema = z.object({
  conversationId: conversationIdSchema.optional(),
});
export type SyncNudgeEvent = z.infer<typeof syncNudgeEventSchema>;

/** Server → client, to the instance that was approved. */
export const instanceApprovedEventSchema = z.object({
  instanceId: instanceIdSchema,
});
export type InstanceApprovedEvent = z.infer<typeof instanceApprovedEventSchema>;

/** Server → client, to the account's other instances (and the revoked one, before it is disconnected). */
export const instanceRevokedEventSchema = z.object({
  instanceId: instanceIdSchema,
});
export type InstanceRevokedEvent = z.infer<typeof instanceRevokedEventSchema>;

/** Server → client: fewer than the low-water mark of key packages remain. Upload more. */
export const keyPackagesLowEventSchema = z.object({
  available: nonNegativeIntSchema,
});
export type KeyPackagesLowEvent = z.infer<typeof keyPackagesLowEventSchema>;

/**
 * Both directions. `ciphertext` is an MLS application message carrying a
 * `typing` {@link AppMessage}; the server relays it to the conversation's other
 * leaves and stores nothing.
 */
export const typingEventSchema = z.object({
  conversationId: conversationIdSchema,
  ciphertext: base64Schema(16 * 1024),
});
export type TypingEvent = z.infer<typeof typingEventSchema>;

/** Server → client, best effort, for accounts sharing a conversation. */
export const presenceEventSchema = z.object({
  accountId: accountIdSchema,
  online: z.boolean(),
});
export type PresenceEvent = z.infer<typeof presenceEventSchema>;

export const SERVER_TO_CLIENT_EVENTS = {
  "sync.nudge": syncNudgeEventSchema,
  "instance.approved": instanceApprovedEventSchema,
  "instance.revoked": instanceRevokedEventSchema,
  "keypackages.low": keyPackagesLowEventSchema,
  typing: typingEventSchema,
  presence: presenceEventSchema,
} as const;

export const CLIENT_TO_SERVER_EVENTS = {
  typing: typingEventSchema,
} as const;

export type ServerToClientEventName = keyof typeof SERVER_TO_CLIENT_EVENTS;
export type ClientToServerEventName = keyof typeof CLIENT_TO_SERVER_EVENTS;

/** Handler maps in the shape Socket.IO's generics take. */
export type ServerToClientEvents = {
  [K in ServerToClientEventName]: (payload: z.infer<(typeof SERVER_TO_CLIENT_EVENTS)[K]>) => void;
};
export type ClientToServerEvents = {
  [K in ClientToServerEventName]: (payload: z.infer<(typeof CLIENT_TO_SERVER_EVENTS)[K]>) => void;
};
