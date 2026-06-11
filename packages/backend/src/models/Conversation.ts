import mongoose, { Schema, Document } from "mongoose";
import type { Network } from "@allo/shared-types";

export type ConversationType = "direct" | "group";

export interface ConversationParticipant {
  userId: string; // Oxy user ID
  role?: "admin" | "member";
  joinedAt: Date;
  lastReadAt?: Date;
}

/**
 * A person on an EXTERNAL network who is part of a bridged conversation.
 *
 * External people are kept OUT of `participants[]` on purpose: that array drives
 * Oxy enrichment, unread counts, `user:` rooms and device-key fetches, none of
 * which apply to a Telegram/WhatsApp/etc. contact. They live here instead.
 */
export interface ExternalParticipant {
  network: Network;
  externalId: string;
  displayName?: string;
  username?: string;
  avatar?: string;
}

/**
 * Binds a conversation to a single external chat on a single network for a
 * single owner. Present ONLY on bridged conversations; absent on native ones.
 */
export interface ConversationBridge {
  network: Network;
  /** Allo user id that owns the linked external account. */
  ownerUserId: string;
  /** External network's id for the chat this conversation mirrors. */
  externalChatId: string;
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
  unreadCounts: Map<string, number>; // userId -> unread count
  archivedBy: string[]; // Array of user IDs who archived this conversation
  // Interop bridge (F3.0): present only on bridged conversations.
  bridge?: ConversationBridge;
  externalParticipants?: ExternalParticipant[];
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

const ExternalParticipantSchema = new Schema<ExternalParticipant>(
  {
    network: { type: String, required: true },
    externalId: { type: String, required: true },
    displayName: { type: String },
    username: { type: String },
    avatar: { type: String },
  },
  { _id: false }
);

const ConversationBridgeSchema = new Schema<ConversationBridge>(
  {
    network: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    externalChatId: { type: String, required: true },
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
        // Native conversations need >= 2 participants. Bridged conversations
        // intentionally have only the OWNER as a participant (the external
        // person lives in `externalParticipants`), so the >= 2 rule is skipped
        // for them and the bridged minimums are enforced in `pre("save")`.
        validator: function (this: IConversation, participants: ConversationParticipant[]) {
          if (this.bridge) return true;
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
      default: new Map(),
    },
    archivedBy: [{ type: String }],
    // Interop bridge (F3.0): both absent on native conversations.
    bridge: { type: ConversationBridgeSchema },
    externalParticipants: { type: [ExternalParticipantSchema] },
  },
  { timestamps: true }
);

// Indexes for efficient queries
ConversationSchema.index({ "participants.userId": 1, lastMessageAt: -1 });
ConversationSchema.index({ createdBy: 1, lastMessageAt: -1 });
ConversationSchema.index({ type: 1, lastMessageAt: -1 });

// One conversation per (network, owner, external chat). Compound SPARSE: a doc
// is indexed only when ALL three keyed fields exist, so native conversations
// (no `bridge`) are excluded entirely and never collide on this unique index.
ConversationSchema.index(
  { "bridge.network": 1, "bridge.ownerUserId": 1, "bridge.externalChatId": 1 },
  { unique: true, sparse: true }
);

// Participant-count rules. Native conversations are unchanged: a `direct` one
// must have exactly 2 participants. Bridged conversations require at least one
// Allo participant (the owner) and at least one external participant.
ConversationSchema.pre("save", function (next) {
  if (this.bridge) {
    if (this.participants.length < 1 || (this.externalParticipants?.length ?? 0) < 1) {
      return next(
        new Error("Bridged conversations require at least 1 participant and 1 externalParticipant")
      );
    }
    return next();
  }
  if (this.type === "direct" && this.participants.length !== 2) {
    return next(new Error("Direct conversations must have exactly 2 participants"));
  }
  next();
});

export const Conversation = mongoose.model<IConversation>("Conversation", ConversationSchema);
export default Conversation;

