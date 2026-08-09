/**
 * Shared conversation transport DTOs for Allo.
 *
 * The wire shape `GET /api/conversations` returns, composed by
 * `packages/backend/src/utils/conversationDto.ts` from the Postgres rows and
 * the enriched participant shape produced by `oxyUserDisplay`
 * (`packages/backend/src/utils/oxyUserDisplay.ts`).
 *
 * This is a TRANSPORT type, not a mirror of a table: `unreadCounts` is
 * reassembled from a column on the participant rows, and `archivedBy` is gone
 * because archival is now one participant's `archivedAt` rather than a list on
 * the conversation.
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
 * ## `_id` is the v1 spelling of `id`, and it is a VERSIONED CONTRACT
 *
 * The rows carry `id`, so `id` is canonical and `_id` is derived from it by
 * the one serializer — they cannot disagree. `_id` is kept because shipped
 * clients read it with NO fallback (`stores/conversationsStore.ts` composes
 * `String(conv._id ?? '')` in two places), and a build already on a phone
 * cannot be recalled: serving `id` alone would give every conversation an
 * empty id, collapse the whole list onto one key, and do it with 200s and
 * valid JSON. It retires when every supported client reads `id` — four other
 * call sites already do (`app/(chat)/c/[id].tsx`, `hooks/useRealtimeMessaging.ts`,
 * `lib/chat/alloApiConversations.ts`), so the remaining two are the condition.
 *
 * `unreadCounts` is REASSEMBLED per response from each participant row's own
 * `unreadCount`. It is required rather than optional precisely because a
 * missing one is invisible: `viewerUnreadCount` returns 0 on absence, so
 * every unread badge in the app would silently read zero.
 */
export interface ConversationDto {
  id: string;
  /** The v1 spelling of {@link ConversationDto.id}. See the note above. */
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
