/**
 * The application-message envelope: what a client encrypts. This is the
 * PLAINTEXT before MLS, so nothing in it ever reaches the server, and the
 * server is not a party to its versioning — `v` is negotiated by clients
 * alone, and a client that meets a `v` it does not know shows nothing.
 *
 * `EventRef` names another message either by the server-assigned event id
 * (`kind: "event"`) or, while the sender's own message is still a local echo
 * with no id yet, by the sender's idempotency key (`kind: "local"`). A
 * receiver resolves a `local` ref by the `(senderInstanceId, idempotencyKey)`
 * of events it has seen from that sender; it is the sender's responsibility
 * to prefer `event` once the id is known.
 */
import { z } from "zod";
import {
  base64Schema,
  blobIdSchema,
  conversationIdSchema,
  eventIdSchema,
  idempotencyKeySchema,
  nonNegativeIntSchema,
  sha256HexSchema,
} from "./common";

export const APP_MESSAGE_VERSION = 1;

export const MAX_TEXT_BODY_LENGTH = 64 * 1024;
export const MAX_REACTION_KEY_LENGTH = 64;
export const MAX_CONVERSATION_NAME_LENGTH = 128;
export const MAX_FILENAME_LENGTH = 255;
export const MAX_MIME_LENGTH = 255;
export const MAX_CAPTION_LENGTH = 4096;

export const eventRefSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("event"), conversationId: conversationIdSchema, eventId: eventIdSchema }),
  z.object({ kind: z.literal("local"), conversationId: conversationIdSchema, idempotencyKey: idempotencyKeySchema }),
]);
export type EventRef = z.infer<typeof eventRefSchema>;

export const MEDIA_KINDS = ["image", "video", "audio", "voice", "file"] as const;
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof mediaKindSchema>;

/** A 32-byte AES-256 content key, base64 (44 chars). */
export const mediaKeySchema = z.base64().length(44);
/** The AES-GCM nonce, base64. 12 bytes is the norm; the bound leaves room. */
export const mediaNonceSchema = base64Schema(64);

export const mediaThumbnailSchema = z.object({
  blobId: blobIdSchema,
  key: mediaKeySchema,
  nonce: mediaNonceSchema,
  sha256: sha256HexSchema,
  width: nonNegativeIntSchema,
  height: nonNegativeIntSchema,
});
export type MediaThumbnail = z.infer<typeof mediaThumbnailSchema>;

const v = z.literal(APP_MESSAGE_VERSION);

export const textMessageSchema = z.object({
  v,
  t: z.literal("text"),
  body: z.string().min(1).max(MAX_TEXT_BODY_LENGTH),
  replyTo: eventRefSchema.optional(),
});
export const editMessageSchema = z.object({
  v,
  t: z.literal("edit"),
  target: eventRefSchema,
  body: z.string().min(1).max(MAX_TEXT_BODY_LENGTH),
});
export const deleteMessageSchema = z.object({
  v,
  t: z.literal("delete"),
  target: eventRefSchema,
});
export const reactionMessageSchema = z.object({
  v,
  t: z.literal("reaction"),
  target: eventRefSchema,
  key: z.string().min(1).max(MAX_REACTION_KEY_LENGTH),
  op: z.enum(["add", "remove"]),
});
/** A read receipt. Encrypted like everything else: the server sees nothing. */
export const readMessageSchema = z.object({
  v,
  t: z.literal("read"),
  upTo: eventRefSchema,
});
export const mediaMessageSchema = z.object({
  v,
  t: z.literal("media"),
  blobId: blobIdSchema,
  key: mediaKeySchema,
  nonce: mediaNonceSchema,
  /** Of the CIPHERTEXT as uploaded — what `X-Allo-Blob-Sha256` carried. */
  sha256: sha256HexSchema,
  mime: z.string().min(1).max(MAX_MIME_LENGTH),
  filename: z.string().min(1).max(MAX_FILENAME_LENGTH),
  /** Plaintext size in bytes. */
  size: nonNegativeIntSchema,
  kind: mediaKindSchema,
  width: nonNegativeIntSchema.optional(),
  height: nonNegativeIntSchema.optional(),
  durationMs: nonNegativeIntSchema.optional(),
  caption: z.string().max(MAX_CAPTION_LENGTH).optional(),
  thumbnail: mediaThumbnailSchema.optional(),
});
/** Group metadata. E2EE, so the server never learns a name. */
export const conversationMessageSchema = z.object({
  v,
  t: z.literal("conversation"),
  name: z.string().min(1).max(MAX_CONVERSATION_NAME_LENGTH).optional(),
});
/** Only ever sent over the socket `typing` channel; never stored as an event. */
export const typingMessageSchema = z.object({
  v,
  t: z.literal("typing"),
  on: z.boolean(),
});

export const appMessageSchema = z.discriminatedUnion("t", [
  textMessageSchema,
  editMessageSchema,
  deleteMessageSchema,
  reactionMessageSchema,
  readMessageSchema,
  mediaMessageSchema,
  conversationMessageSchema,
  typingMessageSchema,
]);
export type AppMessage = z.infer<typeof appMessageSchema>;
export type AppMessageKind = AppMessage["t"];

export class AppMessageDecodeError extends Error {
  override readonly name = "AppMessageDecodeError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    if (options?.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/**
 * UTF-8 JSON. The message is validated first so a malformed envelope fails
 * at the sender and is never encrypted; unknown keys are dropped.
 */
export function encodeAppMessage(message: AppMessage): Uint8Array {
  const parsed = appMessageSchema.safeParse(message);
  if (!parsed.success) throw new AppMessageDecodeError("not a valid AppMessage", { cause: parsed.error });
  return new TextEncoder().encode(JSON.stringify(parsed.data));
}

/** The inverse of {@link encodeAppMessage}. Throws {@link AppMessageDecodeError} on anything else. */
export function decodeAppMessage(bytes: Uint8Array): AppMessage {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new AppMessageDecodeError("AppMessage is not UTF-8 JSON", { cause });
  }
  const parsed = appMessageSchema.safeParse(json);
  if (!parsed.success) throw new AppMessageDecodeError("not a valid AppMessage", { cause: parsed.error });
  return parsed.data;
}
