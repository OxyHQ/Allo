import type { AlloRoomSummary } from '@/lib/matrix/types';

/**
 * The order of the conversation list, and the one piece of account data it
 * depends on.
 *
 * Ordering is here rather than in `client.web.ts` because it is the part of the
 * room list that is a pure function and the part most likely to be wrong in a way
 * only a test would catch. `matrix-js-sdk` hands over an unordered set of rooms —
 * there is no equivalent of the Rust SDK's already-sorted room list — so this is
 * where the web half earns the same output as the native one.
 */

export interface RoomListEntry {
  readonly summary: AlloRoomSummary;
  /**
   * When the room last had an event, in milliseconds since the epoch.
   *
   * The SDK answers `Number.MIN_SAFE_INTEGER` for a room whose timeline it holds
   * nothing for, which sorts such a room last without a special case.
   */
  readonly activityTimestamp: number;
}

/**
 * Most recently active first.
 *
 * Ties are broken by room id, not left to the sort's stability: the input order
 * is whatever `getRooms()` happened to return this time, so without a tie-break
 * two rooms with the same timestamp could swap places between two rebuilds and
 * make the list jump under the user's finger.
 */
export function orderRoomList(entries: readonly RoomListEntry[]): readonly AlloRoomSummary[] {
  return [...entries]
    .sort((left, right) => {
      if (left.activityTimestamp !== right.activityTimestamp) {
        return right.activityTimestamp - left.activityTimestamp;
      }
      return left.summary.roomId < right.summary.roomId ? -1 : 1;
    })
    .map((entry) => entry.summary);
}

/**
 * The rooms the user has marked as direct messages, from the `m.direct` account
 * data event.
 *
 * The event is a map of user id to the rooms shared with them, written by every
 * client the user has ever used, so it is read defensively: anything that is not
 * an array of strings is ignored rather than trusted. A malformed entry costs a
 * room its "direct" flag, which is a wrong avatar; taking it on trust costs a
 * crash in the conversation list.
 */
export function directRoomIds(content: Record<string, unknown> | undefined): ReadonlySet<string> {
  const roomIds = new Set<string>();
  if (content === undefined) {
    return roomIds;
  }
  for (const value of Object.values(content)) {
    if (!Array.isArray(value)) {
      continue;
    }
    for (const roomId of value) {
      if (typeof roomId === 'string') {
        roomIds.add(roomId);
      }
    }
  }
  return roomIds;
}
