import mongoose, { Schema, Document } from "mongoose";
import { ENCRYPTION_VERSION_ENVELOPES } from "@allo/shared-types";
import type { Network } from "@allo/shared-types";

/**
 * Interop bridge (F3.0) metadata on a message.
 *
 * Present ONLY on bridged messages — inbound ones (originated on an external
 * network) and owner-originated outbound ones (queued to a bridged chat). Native
 * Allo messages never carry this. `bridgeStatus` is OUTBOUND-only: it tracks the
 * delivery state of an Allo-sent message to the external network.
 */
export interface MessageExternal {
  network: Network;
  /** External sender id (inbound only). */
  externalSenderId?: string;
  /** External network's message id. */
  externalMessageId?: string;
  /** Timestamp the message had on the external network. */
  externalTimestamp?: Date;
  /** Outbound delivery state (owner -> external network). */
  bridgeStatus?: "queued" | "sent" | "failed";
}

export interface MediaItem {
  id: string;
  type: "image" | "video" | "audio" | "file" | "gif";
  url: string;
  thumbnailUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number; // For video/audio
}

export interface LocationData {
  latitude: number;
  longitude: number;
  address?: string;
  label?: string;
}

export interface ContactData {
  name: string;
  phones?: string[];
  emails?: string[];
  userId?: string;
}

export interface PollOption {
  text: string;
  votes: string[]; // userIds who voted
}

export interface PollData {
  question: string;
  options: PollOption[];
  multi: boolean;
  closed?: boolean;
}

export interface IMessage extends Document {
  conversationId: string;
  senderId: string; // Oxy user ID
  senderDeviceId: number; // Device ID that sent the message
  
  // Encrypted content (Signal Protocol)
  ciphertext?: string; // Base64 encoded encrypted message
  encryptedMedia?: Array<{
    id: string;
    type: "image" | "video" | "audio" | "file";
    ciphertext: string; // Encrypted media data or URL
    thumbnailCiphertext?: string; // Encrypted thumbnail
    fileName?: string;
    fileSize?: number;
    mimeType?: string;
    width?: number;
    height?: number;
    duration?: number;
  }>;
  
  // Legacy plaintext fields (for backward compatibility during migration)
  // These should be empty if encryption is enabled
  text?: string;
  media?: MediaItem[];
  
  // Encryption metadata
  encryptionVersion?: number; // Signal Protocol version (1 legacy, 2 single-blob ratchet, 3 per-device envelopes)
  envelopeCount?: number; // v3 only: number of per-device envelopes fanned out (see MessageEnvelope)
  messageType?: "text" | "media" | "system" | "location" | "contact" | "poll" | "file" | "audio"; // Type of encrypted message
  
  // Attachment metadata (public — not encrypted, for renderable structure / server-side state)
  attachmentType?: "image" | "video" | "audio" | "file" | "location" | "contact" | "poll" | "gif";
  location?: LocationData;
  contact?: ContactData;
  poll?: PollData;
  forwardedFrom?: string; // Original message ID
  hiddenFor?: string[]; // Users who deleted "for me"

  replyTo?: string; // Message ID this is replying to
  fontSize?: number; // Custom font size for this message
  editedAt?: Date;
  deletedAt?: Date;
  readBy: Record<string, Date>; // userId -> read timestamp
  deliveredTo: string[]; // Array of user IDs who received the message
  reactions?: Record<string, string[]>; // emoji -> array of userIds who reacted
  // Interop bridge (F3.0): present only on bridged messages.
  external?: MessageExternal;
  createdAt: Date;
  updatedAt: Date;
}

const MediaItemSchema = new Schema<MediaItem>(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: ["image", "video", "audio", "file", "gif"],
      required: true,
    },
    url: { type: String, required: true },
    thumbnailUrl: { type: String },
    fileName: { type: String },
    fileSize: { type: Number },
    mimeType: { type: String },
    width: { type: Number },
    height: { type: Number },
    duration: { type: Number },
  },
  { _id: false }
);

const LocationSchema = new Schema<LocationData>(
  {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    address: { type: String },
    label: { type: String },
  },
  { _id: false }
);

const ContactSchema = new Schema<ContactData>(
  {
    name: { type: String, required: true },
    phones: [{ type: String }],
    emails: [{ type: String }],
    userId: { type: String },
  },
  { _id: false }
);

const PollOptionSchema = new Schema<PollOption>(
  {
    text: { type: String, required: true },
    votes: [{ type: String }],
  },
  { _id: false }
);

const PollSchema = new Schema<PollData>(
  {
    question: { type: String, required: true },
    options: { type: [PollOptionSchema], default: [] },
    multi: { type: Boolean, default: false },
    closed: { type: Boolean, default: false },
  },
  { _id: false }
);

const EncryptedMediaSchema = new Schema(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: ["image", "video", "audio", "file"],
      required: true,
    },
    ciphertext: { type: String, required: true },
    thumbnailCiphertext: { type: String },
    fileName: { type: String },
    fileSize: { type: Number },
    mimeType: { type: String },
    width: { type: Number },
    height: { type: Number },
    duration: { type: Number },
  },
  { _id: false }
);

const MessageExternalSchema = new Schema<MessageExternal>(
  {
    network: { type: String, required: true },
    externalSenderId: { type: String },
    externalMessageId: { type: String },
    externalTimestamp: { type: Date },
    bridgeStatus: { type: String, enum: ["queued", "sent", "failed"] },
  },
  { _id: false }
);

const MessageSchema = new Schema<IMessage>(
  {
    conversationId: {
      type: String,
      required: true,
      index: true,
      ref: "Conversation",
    },
    senderId: { type: String, required: true, index: true },
    // min is 0 (not 1): deviceId 0 is RESERVED for the bridge origin (inbound
    // bridged messages). The v3 per-device envelope path still requires a real
    // device id >= 1 — enforced separately in `validateEnvelopeMessage` and the
    // `X-Device-Id` header check, both unchanged.
    senderDeviceId: { type: Number, required: true, min: 0 },
    
    // Encrypted content
    ciphertext: { type: String },
    encryptedMedia: [EncryptedMediaSchema],
    encryptionVersion: { type: Number, default: 2 }, // 1 = legacy ECDH+AES-GCM, 2 = X3DH + Double Ratchet wire format, 3 = per-device envelopes
    envelopeCount: { type: Number, min: 0 }, // v3: count of MessageEnvelope docs fanned out for this message
    messageType: {
      type: String,
      enum: ["text", "media", "system", "location", "contact", "poll", "file", "audio"],
      default: "text",
    },
    
    // Legacy plaintext (deprecated, for migration only)
    text: { type: String },
    media: [MediaItemSchema],

    // Attachment metadata (public)
    attachmentType: {
      type: String,
      enum: ["image", "video", "audio", "file", "location", "contact", "poll", "gif"],
    },
    location: { type: LocationSchema },
    contact: { type: ContactSchema },
    poll: { type: PollSchema },
    forwardedFrom: { type: String, ref: "Message" },
    hiddenFor: [{ type: String }],

    replyTo: { type: String, ref: "Message" },
    fontSize: { type: Number, min: 10, max: 72 },
    editedAt: { type: Date },
    deletedAt: { type: Date },
    readBy: {
      type: Map,
      of: Date,
      default: {},
    },
    deliveredTo: [{ type: String }],
    reactions: {
      type: Map,
      of: [String], // Array of user IDs
      default: {},
    },
    // Interop bridge (F3.0): absent on native messages.
    external: { type: MessageExternalSchema },
  },
  { timestamps: true }
);

// Indexes for efficient queries
MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ senderId: 1, createdAt: -1 });
MessageSchema.index({ conversationId: 1, deletedAt: 1, createdAt: -1 });

// Dedup inbound bridged messages: one Allo message per (conversation, external
// message id). Compound SPARSE so only docs with BOTH fields are indexed —
// native messages (no `external.externalMessageId`) are excluded and never
// collide. Lets `handleEvent('message')` rely on the DB for idempotent replay.
MessageSchema.index(
  { conversationId: 1, "external.externalMessageId": 1 },
  { unique: true, sparse: true }
);

// Validation: message must have either encrypted content, legacy plaintext, or a structured attachment
MessageSchema.pre("save", function (next) {
  const hasEncryptedContent = this.ciphertext || (this.encryptedMedia && this.encryptedMedia.length > 0);
  const hasLegacyContent = this.text || (this.media && this.media.length > 0);
  const hasAttachment = Boolean(
    this.attachmentType || this.location || this.contact || this.poll
  );
  // v3 (per-device envelopes): the top-level ciphertext is intentionally empty
  // — the real ciphertext lives in MessageEnvelope docs, counted by envelopeCount.
  const hasEnvelopes =
    this.encryptionVersion === ENCRYPTION_VERSION_ENVELOPES &&
    typeof this.envelopeCount === "number" &&
    this.envelopeCount > 0;
  // A soft-deleted tombstone ("delete for everyone") is intentionally
  // content-free; it keeps only metadata so clients can render "message deleted".
  const isTombstone = Boolean(this.deletedAt);

  if (
    !hasEncryptedContent &&
    !hasLegacyContent &&
    !hasAttachment &&
    !hasEnvelopes &&
    !isTombstone
  ) {
    return next(new Error("Message must have either encrypted content, legacy plaintext, or a structured attachment"));
  }
  
  // If encryption is enabled, plaintext should not be stored
  if (this.ciphertext && this.text) {
    console.warn("Warning: Message has both encrypted and plaintext content");
  }
  
  next();
});

export const Message = mongoose.model<IMessage>("Message", MessageSchema);
export default Message;

