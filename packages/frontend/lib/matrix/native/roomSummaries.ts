import type { AlloRoomSummary } from '@/lib/matrix/types';

import { toRoomSummary, type RoomSummaryFields } from './translate';

/**
 * What this module needs of a room handle, rather than the whole `RoomLike`: the
 * SDK's room satisfies it structurally, so the compiler still checks it at the
 * call site, and a test does not have to conjure an object with a hundred and
 * fifty methods on it.
 */
export interface RoomEntry {
  roomInfo(): Promise<RoomSummaryFields>;
}

/**
 * Turns the mirrored room list into the array the conversation list draws.
 *
 * Unlike a timeline row, a room does not carry its own summary: `roomInfo()` is
 * an async call across the FFI boundary. Doing it for every room on every batch
 * would mean one round trip per conversation every time any conversation
 * receives a message, so summaries are cached by object identity — the binding
 * hands over a fresh room object whenever the entry changes, which is exactly
 * when the summary needs recomputing.
 */
export class RoomSummaryCache {
  #cache = new Map<RoomEntry, AlloRoomSummary>();

  async project(rooms: readonly RoomEntry[]): Promise<readonly AlloRoomSummary[]> {
    const previous = this.#cache;
    const projected = await Promise.all(
      rooms.map(async (room) => ({
        room,
        summary: previous.get(room) ?? toRoomSummary(await room.roomInfo()),
      })),
    );

    const next = new Map<RoomEntry, AlloRoomSummary>();
    for (const { room, summary } of projected) {
      next.set(room, summary);
    }
    this.#cache = next;

    return projected.map(({ summary }) => summary);
  }
}
