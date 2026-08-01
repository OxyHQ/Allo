import type { TimelineUniqueId } from '@unomed/react-native-matrix-sdk';

import type { AlloTimelineItem } from '@/lib/matrix/types';

import { toTimelineItem, type TimelineEventFields } from './translate';

/**
 * What this module needs of a timeline row, rather than the whole
 * `TimelineItemLike`: the SDK's row satisfies it structurally, so the compiler
 * still checks it at the call site, and a test does not have to conjure an object
 * with a hundred and fifty methods on it.
 */
export interface TimelineRow {
  uniqueId(): TimelineUniqueId;
  asEvent(): TimelineEventFields | undefined;
}

/**
 * Turns the mirrored SDK list into the array the UI draws.
 *
 * Two things make this more than a `map`:
 *
 * - Rows that are not events — date separators, the read marker — are dropped.
 *   They are dropped here and not in the mirrored list because the SDK's diffs
 *   address that list by index, so it has to keep the same shape Rust has.
 * - `uniqueId()` and `asEvent()` cross the FFI boundary. Re-reading every row on
 *   every batch would cost one round trip per message in the window per event
 *   received. Rows are therefore cached by object identity, which is sound
 *   because the binding hands over a fresh object whenever a row changes: the
 *   same object is, by construction, the same content.
 */
export class TimelineProjection {
  #cache = new Map<TimelineRow, AlloTimelineItem | null>();

  project(rows: readonly TimelineRow[]): readonly AlloTimelineItem[] {
    const previous = this.#cache;
    const next = new Map<TimelineRow, AlloTimelineItem | null>();
    const items: AlloTimelineItem[] = [];

    for (const row of rows) {
      // `null` means "read, and it is not an event"; `undefined` means "not read
      // yet". Conflating them would re-read every virtual row on every batch.
      const cached = previous.get(row);
      const projected = cached === undefined ? project(row) : cached;
      next.set(row, projected);
      if (projected !== null) {
        items.push(projected);
      }
    }

    this.#cache = next;
    return items;
  }
}

function project(row: TimelineRow): AlloTimelineItem | null {
  const event = row.asEvent();
  return event === undefined ? null : toTimelineItem(row.uniqueId().id, event);
}
