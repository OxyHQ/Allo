import mongoose, { Schema, Document } from "mongoose";

export type ConversationType = "direct" | "group";

export interface ConversationParticipant {
  userId: string; // Oxy user ID
  role?: "admin" | "member";
  joinedAt: Date;
  lastReadAt?: Date;
}

export interface IConversation extends Document {
  type: ConversationType;
  participants: ConversationParticipant[];
  name?: string; // For group conversations
  description?: string; // For group conversations
  avatar?: string; // For group conversations
  theme?: string; // Color theme ID (shared with all participants)
  createdBy: string; // Oxy user ID
  lastMessageAt?: Date;
  lastMessage?: {
    text?: string;
    senderId: string;
    timestamp: Date;
  };
  unreadCounts: Record<string, number>; // userId -> unread count
  archivedBy: string[]; // Array of user IDs who archived this conversation
  createdAt: Date;
  updatedAt: Date;
}

const ConversationParticipantSchema = new Schema<ConversationParticipant>(
  {
    userId: { type: String, required: true },
    role: { type: String, enum: ["admin", "member"], default: "member" },
    joinedAt: { type: Date, default: Date.now },
    lastReadAt: { type: Date },
  },
  { _id: false }
);

const ConversationSchema = new Schema<IConversation>(
  {
    type: {
      type: String,
      enum: ["direct", "group"],
      required: true,
      index: true,
    },
    participants: {
      type: [ConversationParticipantSchema],
      required: true,
      validate: {
        validator: function (participants: ConversationParticipant[]) {
          return participants.length >= 2;
        },
        message: "Conversation must have at least 2 participants",
      },
    },
    name: { type: String },
    description: { type: String },
    avatar: { type: String },
    theme: { type: String }, // Color theme ID (classic, day, purple, teal, etc.)
    createdBy: { type: String, required: true, index: true },
    lastMessageAt: { type: Date, index: true },
    lastMessage: {
      text: { type: String },
      senderId: { type: String },
      timestamp: { type: Date },
    },
    unreadCounts: {
      type: Map,
      of: Number,
      default: {},
    },
    archivedBy: [{ type: String }],
  },
  { timestamps: true }
);

// Indexes for efficient queries
ConversationSchema.index({ "participants.userId": 1, lastMessageAt: -1 });
ConversationSchema.index({ createdBy: 1, lastMessageAt: -1 });
ConversationSchema.index({ type: 1, lastMessageAt: -1 });

// Ensure direct conversations have exactly 2 participants
ConversationSchema.pre("save", function (next) {
  if (this.type === "direct" && this.participants.length !== 2) {
    return next(new Error("Direct conversations must have exactly 2 participants"));
  }
  next();
});

export const Conversation = mongoose.model<IConversation>("Conversation", ConversationSchema);
export default Conversation;

