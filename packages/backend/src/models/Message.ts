import mongoose, { Schema, Document } from "mongoose";

export interface MediaItem {
  id: string;
  type: "image" | "video" | "audio" | "file";
  url: string;
  thumbnailUrl?: string;
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number; // For video/audio
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
  encryptionVersion?: number; // Signal Protocol version
  messageType?: "text" | "media" | "system"; // Type of encrypted message
  
  replyTo?: string; // Message ID this is replying to
  fontSize?: number; // Custom font size for this message
  editedAt?: Date;
  deletedAt?: Date;
  readBy: Record<string, Date>; // userId -> read timestamp
  deliveredTo: string[]; // Array of user IDs who received the message
  reactions?: Record<string, string[]>; // emoji -> array of userIds who reacted
  createdAt: Date;
  updatedAt: Date;
}

const MediaItemSchema = new Schema<MediaItem>(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: ["image", "video", "audio", "file"],
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

const MessageSchema = new Schema<IMessage>(
  {
    conversationId: {
      type: String,
      required: true,
      index: true,
      ref: "Conversation",
    },
    senderId: { type: String, required: true, index: true },
    senderDeviceId: { type: Number, required: true, min: 1 },
    
    // Encrypted content
    ciphertext: { type: String },
    encryptedMedia: [EncryptedMediaSchema],
    encryptionVersion: { type: Number, default: 1 }, // Signal Protocol version
    messageType: {
      type: String,
      enum: ["text", "media", "system"],
      default: "text",
    },
    
    // Legacy plaintext (deprecated, for migration only)
    text: { type: String },
    media: [MediaItemSchema],
    
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
  },
  { timestamps: true }
);

// Indexes for efficient queries
MessageSchema.index({ conversationId: 1, createdAt: -1 });
MessageSchema.index({ senderId: 1, createdAt: -1 });
MessageSchema.index({ conversationId: 1, deletedAt: 1, createdAt: -1 });

// Validation: message must have either encrypted content or legacy plaintext
MessageSchema.pre("save", function (next) {
  const hasEncryptedContent = this.ciphertext || (this.encryptedMedia && this.encryptedMedia.length > 0);
  const hasLegacyContent = this.text || (this.media && this.media.length > 0);
  
  if (!hasEncryptedContent && !hasLegacyContent) {
    return next(new Error("Message must have either encrypted content or legacy plaintext"));
  }
  
  // If encryption is enabled, plaintext should not be stored
  if (this.ciphertext && this.text) {
    console.warn("Warning: Message has both encrypted and plaintext content");
  }
  
  next();
});

export const Message = mongoose.model<IMessage>("Message", MessageSchema);
export default Message;

