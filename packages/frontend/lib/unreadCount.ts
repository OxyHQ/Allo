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
 * ## Why the parameter is typed here rather than as `ConversationDto['unreadCounts']`
 *
 * That field is REQUIRED on the DTO, which is a claim about what the server
 * sends — true, and worth stating there, because the count is reassembled per
 * response and an omission would otherwise be invisible. It is NOT a claim about
 * what this function is handed: conversations also arrive from the AsyncStorage
 * cache written by an older build, where the field can simply be absent. So the
 * guard below is real, and coupling the signature to the DTO would type the
 * absent case out of existence while it still happens at runtime.
 *
 * There is deliberately no `Map` branch. `unreadCounts` reached this function as
 * a `Map` only in the type — JSON has no such shape and the wire never carried
 * one; the union existed because the backend typed its Mongoose `Map` into the
 * transport DTO, and that is exactly what the Postgres port removed.
 */
export function viewerUnreadCount(
  unreadCounts: Record<string, number> | undefined,
  viewerId: string | undefined
): number {
  if (!unreadCounts || !viewerId) return 0;
  return unreadCounts[viewerId] || 0;
}
