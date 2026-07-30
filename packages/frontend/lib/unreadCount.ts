import type { ConversationDto } from '@allo/shared-types';

/**
 * A conversation's unread count for ONE viewer.
 *
 * `unreadCounts` is keyed by user id and carries an entry per participant: the
 * backend increments every participant except the sender, and zeroes only the
 * one who reads. So the map holds other people's unread mail alongside the
 * viewer's, and any reduction over its values reports the whole conversation's
 * backlog as if it were theirs — for a two-person chat, their unread plus the
 * unread of everything they sent.
 *
 * A viewer we cannot name yet has no entry to read, so the count is 0 rather
 * than a guess; the list refetches once the id arrives.
 *
 * The backend serializes the field as a JSON object but types it as
 * `Map | Record` to match its lean/`toObject()` shapes, so both are handled.
 */
export function viewerUnreadCount(
  unreadCounts: ConversationDto['unreadCounts'],
  viewerId: string | undefined
): number {
  if (!unreadCounts || !viewerId) return 0;
  const count =
    unreadCounts instanceof Map
      ? unreadCounts.get(viewerId)
      : unreadCounts[viewerId];
  return count || 0;
}
