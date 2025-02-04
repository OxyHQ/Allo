import mongoose, { Schema, Document } from "mongoose";

export interface IMessage extends Document {
  userID: string;
  conversationID: string;
  message: string;
  status: "sent" | "delivered" | "read";
  createdAt: Date;
  editedAt?: Date;
  forwardedFrom?: string;
  attachments?: Array<{ type: "image" | "video" | "audio" | "file" | "sticker" | "voice"; url: string }>;
  replyTo?: string;
  reactions?: Array<{ emoji: string; userID: string }>;
  pinned?: boolean;
  pinnedAt?: Date;
  pinnedBy?: string;
  scheduledAt?: Date;
  ephemeralExpiresAt?: Date;
  liveLocation?: { latitude: number; longitude: number };
  encrypted?: boolean;
  encryptionAlgorithm?: string;
  signature?: string;
  poll?: { question: string; options: string[]; votes: number[] };
  readBy?: string[];
  spamScore?: number;
}

const AttachmentSchema = new Schema({
  type: { type: String, enum: ["image", "video", "audio", "file", "sticker", "voice"], required: true },
  url: { type: String, required: true },
});

const PollSchema = new Schema({
  question: { type: String, required: true },
  options: [{ type: String, required: true }],
  votes: [{ type: Number, default: 0 }],
});

const MessageSchema = new Schema({
  userID: { type: String, required: true },
  conversationID: { type: String, required: true },
  message: { type: String, required: true },
  status: { type: String, enum: ["sent", "delivered", "read"], default: "sent" },
  editedAt: Date,
  forwardedFrom: String,
  attachments: [AttachmentSchema],
  replyTo: String,
  reactions: [{ emoji: String, userID: String }],
  pinned: Boolean,
  pinnedAt: Date,
  pinnedBy: String,
  scheduledAt: Date,
  ephemeralExpiresAt: Date,
  liveLocation: { latitude: Number, longitude: Number },
  encrypted: Boolean,
  encryptionAlgorithm: String,
  signature: String,
  poll: PollSchema,
  readBy: [String],
  spamScore: Number,
}, { timestamps: true });

// Index to quickly fetch messages in a conversation.
MessageSchema.index({ conversationID: 1, createdAt: -1 });

// TTL index: expired ephemeral messages will be auto-deleted by MongoDB.
MessageSchema.index({ ephemeralExpiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IMessage>("Message", MessageSchema);
