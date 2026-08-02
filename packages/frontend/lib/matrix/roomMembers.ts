import type { AlloRoomMember } from '@/lib/matrix/types';

/**
 * The order a room's members are reported in.
 *
 * Above the platform split, and imported by both halves, because it is a
 * statement about {@link AlloChatClient.roomDetails}'s contract rather than
 * about either SDK. Neither of them orders its member list: the Rust binding
 * hands over an iterator in whatever order its store walks, and
 * `matrix-js-sdk` hands over the values of a map. Left as they come, the same
 * unchanged room answers differently between two reads, and a list that
 * reshuffles under the reader is a bug that looks like a rendering glitch.
 *
 * **By the name the row draws, not by the user id.** A list ordered by MXID is
 * ordered by a string the user never sees. Somebody who has set no display name
 * falls back to their id, which is what their row shows too, so the order is
 * always the order on screen.
 *
 * The comparison is plain and deliberately not `localeCompare`: Hermes only
 * has the full collator when Intl is compiled in, and a member list that is
 * ordered one way on iOS and another on Android is worse than one ordered by
 * code point everywhere. Lowercasing first is what keeps `alice` next to
 * `Alice` rather than in a separate block after every capital letter.
 */
export function orderRoomMembers(
  members: readonly AlloRoomMember[],
): readonly AlloRoomMember[] {
  return [...members].sort((left, right) => {
    const leftKey = sortKey(left);
    const rightKey = sortKey(right);
    if (leftKey !== rightKey) {
      return leftKey < rightKey ? -1 : 1;
    }
    // Two members can draw the same name — Matrix allows it, and the SDKs
    // report it as ambiguous rather than refusing it. The user id is the
    // tiebreaker because it is the one thing that cannot repeat.
    return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
  });
}

function sortKey(member: AlloRoomMember): string {
  return (member.displayName ?? member.userId).toLowerCase();
}
