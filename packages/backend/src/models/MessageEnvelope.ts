import mongoose, { Schema, Document } from "mongoose";

/**
 * MessageEnvelope (encryption version 3, multi-device fan-out).
 *
 * One logical message produces one MessageEnvelope per recipient *device*. Each
 * holds an opaque, per-device Signal ciphertext. The backend never decrypts
 * these; it stores them for REST hydration and addresses real-time delivery to
 * the device room `device:{recipientUserId}:{recipientDeviceId}`.
 *
 * Lifecycle (see src/config/multiDevice.ts):
 *  - Created with `expiresAt = now + ENVELOPE_RETENTION_DAYS`.
 *  - On delivery, `deliveredAt` is set and `expiresAt` is shortened to
 *    `now + ENVELOPE_DELIVERED_RETENTION_DAYS`.
 *  - A TTL index on `expiresAt` reaps expired envelopes automatically.
 */
export interface IEnvelopeMediaKey {
  mediaId: string;
  wrappedKey: string;
}

export interface IMessageEnvelope extends Document {
  messageId: string; // ref Message._id
  conversationId: string;
  senderId: string;
  senderDeviceId: number;
  recipientUserId: string;
  recipientDeviceId: number;
  ciphertext: string; // opaque per-device Signal wire-format ciphertext
  mediaKeys?: IEnvelopeMediaKey[];
  deliveredAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EnvelopeMediaKeySchema = new Schema<IEnvelopeMediaKey>(
  {
    mediaId: { type: String, required: true },
    wrappedKey: { type: String, required: true },
  },
  { _id: false }
);

const MessageEnvelopeSchema = new Schema<IMessageEnvelope>(
  {
    messageId: { type: String, required: true, ref: "Message" },
    conversationId: { type: String, required: true },
    senderId: { type: String, required: true },
    senderDeviceId: { type: Number, required: true, min: 1 },
    recipientUserId: { type: String, required: true },
    recipientDeviceId: { type: Number, required: true, min: 1 },
    ciphertext: { type: String, required: true },
    mediaKeys: { type: [EnvelopeMediaKeySchema], default: undefined },
    deliveredAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// Exactly one envelope per (message, recipient device).
MessageEnvelopeSchema.index(
  { messageId: 1, recipientUserId: 1, recipientDeviceId: 1 },
  { unique: true }
);

// Per-device inbox lookup (REST hydration & pulls), newest first.
MessageEnvelopeSchema.index({ recipientUserId: 1, recipientDeviceId: 1, createdAt: -1 });

// TTL: documents are removed once `expiresAt` is in the past.
MessageEnvelopeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const MessageEnvelope = mongoose.model<IMessageEnvelope>(
  "MessageEnvelope",
  MessageEnvelopeSchema
);
export default MessageEnvelope;
