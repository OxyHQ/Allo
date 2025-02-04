import mongoose, { Schema, Document } from "mongoose";

export interface IConversation extends Document {
  participants: string[];
  topic?: string;
  lastMessage?: string;
  lastUpdated?: Date;
  type: "private" | "group" | "channel";
  owner?: string;
  admins?: string[];
}

const ConversationSchema = new Schema({
  participants: [{ type: String, required: true }],
  topic: { type: String },
  lastMessage: { type: String },
  lastUpdated: { type: Date },
  type: { type: String, enum: ["private", "group", "channel"], default: "private" },
  owner: { type: String },
  admins: { type: [String] }, // new field for group/channel admins
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Index to quickly find conversations by participants.
ConversationSchema.index({ participants: 1 });

export default mongoose.model<IConversation>("Conversation", ConversationSchema);
