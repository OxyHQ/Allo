/**
 * Shared message transport DTOs for Allo.
 *
 * The wire shape the messages routes return, composed by
 * `packages/backend/src/utils/messageDto.ts` from the Postgres rows.
 *
 * `readBy` and `reactions` are `Record<string, ...>` on the wire because that
 * is what they have always been; the rows behind them are now
 * `message_reads` and `message_reactions`, folded back into keyed collections
 * by the serializer.
 */

export type MediaKind = "image" | "video" | "audio" | "file";

export type MessageKind = "text" | "media" | "system";

/**
 * Plaintext media descriptor (legacy / pre-encryption path).
 */
export interface MediaItem {
  id: string;
  type: MediaKind;
  url: string;
  thumbnailUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  width?: number;
  height?: number;
  /** For video/audio, in seconds. */
  duration?: number;
}

/**
 * Encrypted media descriptor (Signal Protocol path).
 */
export interface EncryptedMediaItem {
  id: string;
  type: MediaKind;
  ciphertext: string;
  thumbnailCiphertext?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;
}

/**
 * Serialized message returned by the messages API.
 *
 * `Date` fields are typed as `Date` because that is what the backend assigns
 * from; clients receive the JSON-serialized ISO string at runtime.
 *
 * ## `_id` is the v1 spelling of `id`, and it is a VERSIONED CONTRACT
 *
 * Same rule, and same reason, as `ConversationDto`: `id` is canonical and
 * `_id` is derived from it by the one serializer, so they cannot disagree.
 * `stores/messagesStore.ts` reads `String(msg._id)` with no fallback — which
 * on absence yields the literal string `"undefined"` rather than an empty one
 * — so a shipped build needs `_id` to keep addressing messages at all. It
 * retires when every supported client reads `id`; `hooks/useRealtimeMessaging.ts`
 * already falls back correctly, so that one store is the condition.
 */
export interface MessageDto {
  id: string;
  /** The v1 spelling of {@link MessageDto.id}. See the note above. */
  _id: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: number;

  /** Base64 encoded encrypted message (Signal Protocol). */
  ciphertext?: string;
  encryptedMedia?: EncryptedMediaItem[];

  /** Legacy plaintext fields (migration only). */
  text?: string;
  media?: MediaItem[];

  encryptionVersion?: number;
  messageType?: MessageKind;

  /** Message ID this is replying to. */
  replyTo?: string;
  fontSize?: number;
  editedAt?: Date;
  deletedAt?: Date;

  /** userId -> read timestamp. One `message_reads` row per person, folded up. */
  readBy?: Record<string, Date>;
  /** User IDs who received the message. */
  deliveredTo?: string[];
  /** emoji -> the userIds who reacted, oldest first. From `message_reactions`. */
  reactions?: Record<string, string[]>;

  createdAt?: Date;
  updatedAt?: Date;
}
