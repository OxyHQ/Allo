/**
 * The conversation wire shape, composed in ONE place.
 *
 * `utils/userSettings.ts` is the precedent: the social switch put its
 * row → DTO translation in a single module rather than inline in the route, so
 * the shape a client receives is stated once and can be tested without an HTTP
 * server. This is the same job for messaging.
 *
 * ## Why this file exists at all, rather than spreading the row
 *
 * The Mongo document and the Postgres rows are NOT the same shape, and two of
 * the differences are invisible if you get them wrong:
 *
 * - **`unreadCounts` moved onto the participant rows.** It was a
 *   `Map<userId, number>` on the conversation; it is now one `unreadCount`
 *   column per membership, which is what makes "a count for somebody who is not
 *   in the conversation" unrepresentable. Rebuilding the map here is therefore
 *   not a formality — it is the whole reason the client still gets a number.
 *   Omit it and nothing raises: `viewerUnreadCount` (frontend
 *   `lib/unreadCount.ts`) opens with `if (!unreadCounts || !viewerId) return 0`,
 *   so every unread badge in the app reads zero, over 200s and valid JSON.
 *   {@link ConversationDto.unreadCounts} is required for that reason — the
 *   compiler refuses the omission, and a test pins the contents.
 *
 * - **`archivedBy` is gone entirely.** It was a list of user ids on the
 *   conversation and it was only ever a server-side FILTER; it is now
 *   `conversation_participants.archived_at`, and the filter is the
 *   `isNull(archivedAt)` predicate inside `listConversationsForUser`. Nothing
 *   in the repo reads it off a response, so it is dropped rather than
 *   reassembled — reassembling it would mean publishing, to every participant,
 *   which of the others have archived the conversation.
 */

import type {
  ConversationDto,
  ConversationParticipant,
  EnrichedConversationParticipant,
} from "@allo/shared-types";
import type {
  ConversationParticipantRecord,
  ConversationRecord,
} from "../db/messaging/conversationRepository";

/**
 * A participant row as the un-enriched shape `enrichParticipantWithOxyUser`
 * accepts.
 *
 * `unreadCount` and `archivedAt` deliberately do NOT travel: the first is
 * aggregated into {@link ConversationDto.unreadCounts} for the whole
 * conversation, and the second is one person's private state.
 */
export function toConversationParticipant(
  participant: ConversationParticipantRecord,
): ConversationParticipant {
  return {
    userId: participant.userId,
    role: participant.role,
    joinedAt: participant.joinedAt,
    ...(participant.lastReadAt !== null ? { lastReadAt: participant.lastReadAt } : {}),
  };
}

/**
 * `unreadCounts`, reassembled from the rows that now carry it.
 *
 * Every participant appears, including those on zero — the Map did too, and a
 * client diffing two responses would otherwise read a dropped key as "no
 * change" rather than "now read".
 */
function toUnreadCounts(
  participants: readonly ConversationParticipantRecord[],
): Record<string, number> {
  const unreadCounts: Record<string, number> = {};
  for (const participant of participants) {
    unreadCounts[participant.userId] = participant.unreadCount;
  }
  return unreadCounts;
}

/**
 * One conversation, as the API returns it.
 *
 * `participants` is passed in already enriched rather than enriched here: that
 * step calls out to Oxy and is batched across a whole page by the route, so
 * doing it per conversation would reintroduce the N+1 the batch exists to
 * avoid. The counts still come from `conversation.participants` — the rows —
 * so enrichment cannot drop or reorder them out of the map.
 *
 * Absent optional fields are OMITTED rather than emitted as `null`, which is
 * what the Mongo `.lean()` documents did; clients test them for truthiness, and
 * changing absence into an explicit null is a wire change nothing asked for.
 */
export function toConversationDto(
  conversation: ConversationRecord,
  participants: EnrichedConversationParticipant[],
): ConversationDto {
  return {
    id: conversation.id,
    // Derived from `id` rather than stored beside it, so the two spellings
    // cannot disagree. See the note on ConversationDto for what still reads it.
    _id: conversation.id,
    type: conversation.type,
    participants,
    ...(conversation.name !== null ? { name: conversation.name } : {}),
    ...(conversation.description !== null ? { description: conversation.description } : {}),
    ...(conversation.avatar !== null ? { avatar: conversation.avatar } : {}),
    ...(conversation.theme !== null ? { theme: conversation.theme } : {}),
    createdBy: conversation.createdBy,
    ...(conversation.lastMessageAt !== null ? { lastMessageAt: conversation.lastMessageAt } : {}),
    ...(conversation.lastMessage !== null
      ? {
          lastMessage: {
            ...(conversation.lastMessage.text !== null
              ? { text: conversation.lastMessage.text }
              : {}),
            senderId: conversation.lastMessage.senderId,
            timestamp: conversation.lastMessage.timestamp,
          },
        }
      : {}),
    unreadCounts: toUnreadCounts(conversation.participants),
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  };
}
