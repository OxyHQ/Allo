import type { AlloRoomSummary } from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { toRoomSummary, type RoomPreviewFields, type RoomSummaryFields } from './translate';

/**
 * What this module needs of a room handle, rather than the whole `RoomLike`: the
 * SDK's room satisfies it structurally, so the compiler still checks it at the
 * call site, and a test does not have to conjure an object with a hundred and
 * fifty methods on it.
 */
export interface RoomEntry {
  roomInfo(): Promise<RoomSummaryFields>;
  /** The room's most recent message-like event, if the binding cached one. */
  latestEvent(): Promise<RoomPreviewFields | undefined>;
}

const LOG_TAG = '[matrix]';

/**
 * Turns the mirrored room list into the array the conversation list draws.
 *
 * Unlike a timeline row, a room does not carry its own summary: `roomInfo()` and
 * `latestEvent()` are async calls across the FFI boundary. Doing them for every
 * room on every batch would mean two round trips per conversation every time any
 * conversation receives a message, so summaries are cached by object identity —
 * the binding hands over a fresh room object whenever the entry changes, which is
 * exactly when the summary needs recomputing.
 */
export class RoomSummaryCache {
  #cache = new Map<RoomEntry, AlloRoomSummary>();

  async project(rooms: readonly RoomEntry[]): Promise<readonly AlloRoomSummary[]> {
    const previous = this.#cache;
    const projected = await Promise.all(
      rooms.map(async (room) => ({
        room,
        summary: previous.get(room) ?? (await this.#read(room)),
      })),
    );

    const next = new Map<RoomEntry, AlloRoomSummary>();
    for (const { room, summary } of projected) {
      next.set(room, summary);
    }
    this.#cache = next;

    return projected.map(({ summary }) => summary);
  }

  /**
   * Both halves of a summary, read together.
   *
   * The two calls go out at once because they are independent and each is a round
   * trip; awaiting them in sequence would double the latency of a batch.
   */
  async #read(room: RoomEntry): Promise<AlloRoomSummary> {
    const [info, preview] = await Promise.all([room.roomInfo(), this.#latestEvent(room)]);
    return toRoomSummary(info, preview);
  }

  /**
   * The room's latest event, or nothing.
   *
   * A preview that cannot be read is not a reason to lose the room: the row still
   * has a name, an avatar and an unread count, and a list that vanished because
   * one conversation's last message could not be fetched would be a worse answer
   * than a row with no preview. The failure is reported rather than swallowed,
   * and costs one line per room rather than one per batch because the summary it
   * belongs to is cached either way.
   */
  async #latestEvent(room: RoomEntry): Promise<RoomPreviewFields | undefined> {
    try {
      return await room.latestEvent();
    } catch (error) {
      logger.warn(`${LOG_TAG} a room's latest message could not be read`, error);
      return undefined;
    }
  }
}
