/**
 * Shared conversation transport DTOs for Allo.
 *
 * Mirrors the serialized shape of the `Conversation` mongoose model
 * (`packages/backend/src/models/Conversation.ts`) and the enriched
 * participant shape produced by `oxyUserDisplay`
 * (`packages/backend/src/utils/oxyUserDisplay.ts`) as returned by
 * `GET /api/conversations`.
 */

export type ConversationType = "direct" | "group";

export type ConversationParticipantRole = "admin" | "member";

/**
 * Raw conversation participant as stored on the conversation document.
 */
export interface ConversationParticipant {
  userId: string;
  role?: ConversationParticipantRole;
  joinedAt: Date;
  lastReadAt?: Date;
}

/**
 * Display name resolved from the participant's Oxy profile.
 *
 * `displayName` is the canonical, ready-to-render string composed by the Oxy
 * API (`name.displayName`). Consumers render it directly; `first` / `last` are
 * retained for callers that need the split parts but must NOT be used to
 * recompose a display name.
 */
export interface ParticipantDisplayName {
  displayName: string;
  first: string;
  last: string;
}

/**
 * Participant enriched with Oxy profile data (name, username, avatar).
 * This is what the conversations API returns for each participant.
 */
export interface EnrichedConversationParticipant extends ConversationParticipant {
  name?: ParticipantDisplayName;
  username?: string;
  avatar?: string;
}

/**
 * Last-message preview embedded on a conversation.
 */
export interface ConversationLastMessage {
  text?: string;
  senderId: string;
  timestamp: Date;
}

/**
 * Serialized conversation returned by the conversations API, with
 * participants enriched via Oxy.
 *
 * `unreadCounts` is a mongoose `Map` on the model; it serializes to a
 * JSON object on the wire but is typed as `Map | Record` to match the
 * lean / `toObject()` shapes the backend assigns from without a cast.
 */
export interface ConversationDto {
  _id?: unknown;
  type?: ConversationType;
  participants: EnrichedConversationParticipant[];
  name?: string;
  description?: string;
  avatar?: string;
  /** Color theme ID shared with all participants. */
  theme?: string;
  createdBy?: string;
  lastMessageAt?: Date;
  lastMessage?: ConversationLastMessage;
  unreadCounts?: Map<string, number> | Record<string, number>;
  archivedBy?: string[];
  createdAt?: Date;
  updatedAt?: Date;
}
