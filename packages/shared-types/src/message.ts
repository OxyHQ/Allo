/**
 * Shared message transport DTOs for Allo.
 *
 * Mirrors the serialized shape of the `Message` mongoose model
 * (`packages/backend/src/models/Message.ts`) as returned by the
 * messages routes (`packages/backend/src/routes/messages.ts`).
 *
 * Mongoose `Map` fields serialize to JSON objects, so `readBy` and
 * `reactions` are modeled as `Record<string, ...>` on the wire.
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
 * The backend serves lean mongoose documents; `Date` fields are typed
 * as `Date` to match the lean document shape the backend assigns from,
 * while clients accept the JSON-serialized ISO string at runtime.
 */
export interface MessageDto {
  _id?: unknown;
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

  /** userId -> read timestamp (mongoose Map serialized to an object). */
  readBy?: Record<string, Date>;
  /** User IDs who received the message. */
  deliveredTo?: string[];
  /** emoji -> array of userIds who reacted (mongoose Map serialized to an object). */
  reactions?: Record<string, string[]>;

  createdAt?: Date;
  updatedAt?: Date;
}
