/**
 * The wire shapes of the legacy `allo-api` chat path, as the frontend still
 * reads them.
 *
 * These used to be exported by `@allo/shared-types`. That package now carries
 * only the v1 platform contract (`docs/platform/api-v1.md`), and the legacy
 * path is a temporary scaffold that goes when the app moves to `@allo/react`
 * — so the shapes it reads live here, next to the code that reads them, and
 * leave with it. Nothing new may import this module.
 */

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export type ConversationType = 'direct' | 'group';

export type ConversationParticipantRole = 'admin' | 'member';

export interface ConversationParticipant {
  userId: string;
  role?: ConversationParticipantRole;
  joinedAt: Date;
  lastReadAt?: Date;
}

/**
 * Display name resolved from the participant's Oxy profile. `displayName` is
 * the ready-to-render string; `first` / `last` are never recomposed.
 */
export interface ParticipantDisplayName {
  displayName: string;
  first: string;
  last: string;
}

/** Participant enriched with Oxy profile data (name, username, avatar). */
export interface EnrichedConversationParticipant extends ConversationParticipant {
  name?: ParticipantDisplayName;
  username?: string;
  avatar?: string;
}

export interface ConversationLastMessage {
  text?: string;
  senderId: string;
  timestamp: Date;
}

/**
 * Serialized conversation returned by `GET /api/conversations`.
 *
 * `_id` is the older spelling of `id`; the serializer derives one from the
 * other, so they cannot disagree, and the store still reads `_id`.
 * `unreadCounts` is keyed by user id and is required: a missing map would read
 * as zero unread everywhere.
 */
export interface ConversationDto {
  id: string;
  _id: string;
  type: ConversationType;
  participants: EnrichedConversationParticipant[];
  name?: string;
  description?: string;
  avatar?: string;
  /** Color theme ID shared with all participants. */
  theme?: string;
  createdBy: string;
  lastMessageAt?: Date;
  lastMessage?: ConversationLastMessage;
  /** userId -> that participant's unread count. */
  unreadCounts: Record<string, number>;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MediaKind = 'image' | 'video' | 'audio' | 'file';

export type MessageKind = 'text' | 'media' | 'system';

/** Plaintext media descriptor. */
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

/** Encrypted media descriptor. */
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
 * Serialized message returned by the messages routes.
 *
 * `Date` fields arrive as ISO strings at runtime. `_id` is the older spelling
 * of `id`, kept for the same reason as on {@link ConversationDto}.
 */
export interface MessageDto {
  id: string;
  _id: string;
  conversationId: string;
  senderId: string;
  senderDeviceId: number;

  /** Base64 encoded encrypted message body. */
  ciphertext?: string;
  encryptedMedia?: EncryptedMediaItem[];

  /** Plaintext fields, used when encryption was unavailable. */
  text?: string;
  media?: MediaItem[];

  encryptionVersion?: number;
  messageType?: MessageKind;

  /** Message ID this is replying to. */
  replyTo?: string;
  fontSize?: number;
  editedAt?: Date;
  deletedAt?: Date;

  /** userId -> read timestamp. */
  readBy?: Record<string, Date>;
  /** User IDs who received the message. */
  deliveredTo?: string[];
  /** emoji -> the userIds who reacted, oldest first. */
  reactions?: Record<string, string[]>;

  createdAt?: Date;
  updatedAt?: Date;
}

// ---------------------------------------------------------------------------
// Devices and key bundles
// ---------------------------------------------------------------------------

/** Signed pre-key bundle entry (Base64 encoded values). */
export interface SignedPreKey {
  keyId: number;
  publicKey: string;
  signature: string;
}

/** One-time pre-key entry (Base64 encoded values). */
export interface PreKey {
  keyId: number;
  publicKey: string;
}

/** Serialized device record returned by the devices routes. */
export interface DeviceDto {
  id: string;
  userId: string;
  /** The device number, 1-based and unique only within a user. */
  deviceId: number;
  /** Base64 encoded public identity key. */
  identityKeyPublic: string;
  signedPreKey: SignedPreKey;
  preKeys?: PreKey[];
  registrationId: number;
  lastSeen: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Public device bundle returned for key exchange
 * (`GET /api/devices/user/:userId`); excludes one-time pre-keys.
 */
export interface PublicDeviceBundle {
  id: string;
  deviceId: number;
  identityKeyPublic: string;
  signedPreKey: SignedPreKey;
  registrationId: number;
}
