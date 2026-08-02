import type { AlloRoomPreview, AlloRoomSummary } from '@/lib/matrix/types';

import { toRoomPreview, type TimelineEventFields } from './translate';

/**
 * The order of the conversation list, the preview each row shows, and the one
 * piece of account data both depend on.
 *
 * All of it is here rather than in `client.web.ts` because it is the part of the
 * room list that is a pure function and the part most likely to be wrong in a way
 * only a test would catch. `matrix-js-sdk` hands over an unordered set of rooms
 * and no notion of a room's latest message — there is no equivalent of the Rust
 * SDK's already-sorted room list or of its latest-event cache — so this is where
 * the web half earns the same output as the native one.
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
 * How far back a room's loaded timeline is searched for something to preview.
 *
 * There is a limit at all because the search is per room and the list is rebuilt
 * on every sync response: a room whose loaded history is nothing but membership
 * changes would otherwise be walked end to end, for every room, several times a
 * minute. Twenty is the size of the first sync's slice per room, so in the case
 * this is really guarding against — a quiet room full of people coming and going
 * — the walk ends where the loaded history does.
 *
 * Giving up leaves the row with no preview, which is a row that says less than it
 * could. It is not a row that says something false.
 */
const PREVIEW_SEARCH_LIMIT = 20;

/**
 * The most recent event of a room that a conversation row can preview.
 *
 * Not simply the last one. `getLastLiveEvent()` answers with the latest event of
 * any type, so a room's preview would become "someone joined" every time someone
 * did, and the message that was there a second ago would be gone. Walking
 * backwards to the last *message* is what the Rust SDK's latest-event cache does
 * for the native half without being asked.
 *
 * @param events one room's loaded timeline, oldest first, as the SDK holds it.
 */
export function selectRoomPreview(
  events: readonly TimelineEventFields[],
  viewerUserId: string,
): AlloRoomPreview | undefined {
  const oldestToConsider = Math.max(0, events.length - PREVIEW_SEARCH_LIMIT);
  for (let index = events.length - 1; index >= oldestToConsider; index -= 1) {
    const event = events[index];
    const preview = event === undefined ? undefined : toRoomPreview(event, viewerUserId);
    if (preview !== undefined) {
      return preview;
    }
  }
  return undefined;
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
