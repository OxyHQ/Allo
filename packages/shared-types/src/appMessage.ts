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
export const MAX_POLL_QUESTION_LENGTH = 512;
export const MAX_POLL_OPTION_LENGTH = 128;
export const MAX_POLL_OPTIONS = 12;
export const MAX_PLACE_LABEL_LENGTH = 256;
export const MAX_CONTACT_NAME_LENGTH = 128;
export const MAX_CONTACT_DETAIL_LENGTH = 128;

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
/**
 * A delivery receipt, sent by a RECEIVING instance once it has imported
 * everything up to `upTo`. Encrypted like `read`, so the server learns
 * nothing; a receiver acts on it only when it comes from another account.
 */
export const deliveredMessageSchema = z.object({
  v,
  t: z.literal("delivered"),
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
/**
 * A poll. The options are fixed when it is sent — an id per option, because a
 * vote names one and a label can be edited in a future version without
 * orphaning the votes cast against it.
 */
export const pollMessageSchema = z.object({
  v,
  t: z.literal("poll"),
  question: z.string().min(1).max(MAX_POLL_QUESTION_LENGTH),
  options: z
    .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(MAX_POLL_OPTION_LENGTH) }))
    .min(2)
    .max(MAX_POLL_OPTIONS),
  /** Whether a voter may choose more than one option. */
  multiple: z.boolean(),
  /**
   * Whether the SENDER asked for the voters not to be named. The server never
   * sees either way; every client in the group can still see who voted, so
   * this is a request the UI honours, not a guarantee it can make.
   */
  anonymous: z.boolean(),
});

/**
 * One account's answer to a poll. The LAST vote wins, and an empty list
 * retracts — a vote is a statement of the voter's current answer rather than
 * an increment, so a client that misses one still ends up with the right
 * total.
 */
export const pollVoteMessageSchema = z.object({
  v,
  t: z.literal("poll_vote"),
  target: eventRefSchema,
  optionIds: z.array(z.string().min(1).max(64)).max(MAX_POLL_OPTIONS),
});

/**
 * A place. Coordinates and a name the sender chose; nothing is resolved by
 * Allo, and no map tile is fetched by the SDK.
 */
export const locationMessageSchema = z.object({
  v,
  t: z.literal("location"),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  label: z.string().min(1).max(MAX_PLACE_LABEL_LENGTH).optional(),
  address: z.string().min(1).max(MAX_PLACE_LABEL_LENGTH).optional(),
});

/**
 * Somebody's card. `accountId` is set when the card names an Oxy account, so
 * the receiver can open a conversation with them; a card for somebody outside
 * Oxy carries only what the sender typed.
 */
export const contactMessageSchema = z.object({
  v,
  t: z.literal("contact"),
  name: z.string().min(1).max(MAX_CONTACT_NAME_LENGTH),
  accountId: z.string().min(1).max(64).optional(),
  handle: z.string().min(1).max(MAX_CONTACT_DETAIL_LENGTH).optional(),
  phone: z.string().min(1).max(MAX_CONTACT_DETAIL_LENGTH).optional(),
});

/**
 * Pinning a message for everybody in the conversation. A control message, not
 * a timeline entry: clients fold the last op per target, so two devices that
 * pin and unpin in either order agree on the result.
 */
export const pinMessageSchema = z.object({
  v,
  t: z.literal("pin"),
  target: eventRefSchema,
  op: z.enum(["pin", "unpin"]),
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
  deliveredMessageSchema,
  mediaMessageSchema,
  conversationMessageSchema,
  pollMessageSchema,
  pollVoteMessageSchema,
  locationMessageSchema,
  contactMessageSchema,
  pinMessageSchema,
  typingMessageSchema,
]);
export type AppMessage = z.infer<typeof appMessageSchema>;
export type AppMessageKind = AppMessage["t"];

/**
 * A CONTROL message this client does not know, which says so itself.
 *
 * `ctl: true` is the sender's promise that a receiver which ignores this
 * message entirely loses nothing a person would see — it drives something
 * (a call, a receipt, a device's own housekeeping) rather than being
 * something somebody wrote.
 *
 * Without it, an unknown `t` is a decode failure, and a decode failure is
 * drawn in the conversation as "this message could not be decrypted". Every
 * control kind added after a release would therefore litter the timeline of
 * every device still on the release before it. That is why this lands BEFORE
 * the first kind that needs it: the clients in the field have to learn to
 * ignore before there is anything to ignore.
 *
 * This schema is only ever used to DECODE. A build that knows the kind parses
 * it as itself, and every control kind declares `ctl: z.literal(true)` in its
 * own schema so the marker survives `encodeAppMessage`, which strips what the
 * matching schema does not name.
 *
 * A CONTENT kind — something a person sent and would expect to see — must NOT
 * carry the marker. An old client saying "this message could not be
 * displayed" is right about a message it cannot draw, and wrong only about
 * machinery.
 */
export const unknownControlMessageSchema = z.object({
  v,
  t: z.string().min(1).max(64),
  ctl: z.literal(true),
});
export type UnknownControlMessage = z.infer<typeof unknownControlMessageSchema>;

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
  const parsed = appMessageSchema.safeParse(parseJson(bytes));
  if (!parsed.success) throw new AppMessageDecodeError("not a valid AppMessage", { cause: parsed.error });
  return parsed.data;
}

/**
 * {@link decodeAppMessage}, but `null` for a message this build should ignore
 * rather than report: a control kind from a newer client, marked `ctl: true`
 * (see {@link unknownControlMessageSchema}).
 *
 * This is the function a RECEIVER uses. `null` means "nothing to do and
 * nothing to show"; a throw still means a message this build cannot read and
 * should say so about.
 */
export function decodeAppMessageOrIgnore(bytes: Uint8Array): AppMessage | null {
  const json = parseJson(bytes);
  const parsed = appMessageSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  if (unknownControlMessageSchema.safeParse(json).success) return null;
  throw new AppMessageDecodeError("not a valid AppMessage", { cause: parsed.error });
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (cause) {
    throw new AppMessageDecodeError("AppMessage is not UTF-8 JSON", { cause });
  }
}
