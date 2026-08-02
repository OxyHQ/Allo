import type { TimelineUniqueId } from '@unomed/react-native-matrix-sdk';

import { markReadByOthers } from '@/lib/matrix/readReceipts';
import type { AlloTimelineItem } from '@/lib/matrix/types';

import { toReaders, toTimelineItem, type TimelineEventFields } from './translate';

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
 * A row that has been read across the FFI boundary, kept so it is not read again.
 *
 * Two items rather than one because a row's read mark is not a property of the
 * row: it comes from receipts on *later* rows, so the same event is drawn read or
 * unread depending on what came after it, while the expensive part — the two FFI
 * calls that produced it — is the same either way. The read variant is built when
 * it is first needed and then kept, which is what lets an unchanged conversation
 * hand back the very same objects on the next batch.
 */
class ProjectedRow {
  readonly readers: readonly string[];
  readonly #unread: AlloTimelineItem;
  #read: AlloTimelineItem | undefined;

  constructor(item: AlloTimelineItem, readers: readonly string[]) {
    this.#unread = item;
    this.readers = readers;
  }

  get sender(): string {
    return this.#unread.sender;
  }

  item(isReadByOthers: boolean): AlloTimelineItem {
    if (!isReadByOthers) {
      return this.#unread;
    }
    this.#read ??= { ...this.#unread, isReadByOthers: true };
    return this.#read;
  }
}

/**
 * Turns the mirrored SDK list into the array the UI draws.
 *
 * Three things make this more than a `map`:
 *
 * - Rows that are not events — date separators, the read marker — are dropped.
 *   They are dropped here and not in the mirrored list because the SDK's diffs
 *   address that list by index, so it has to keep the same shape Rust has.
 * - `uniqueId()` and `asEvent()` cross the FFI boundary. Re-reading every row on
 *   every batch would cost one round trip per message in the window per event
 *   received. Rows are therefore cached by object identity, which is sound
 *   because the binding hands over a fresh object whenever a row changes: the
 *   same object is, by construction, the same content.
 * - Read receipts are resolved over the whole list rather than per row. A
 *   receipt names one event and covers everything before it, so the second pass
 *   below is not an optimisation of a per-row answer — it is the only place the
 *   answer exists. Cheap, too: it touches no FFI at all.
 */
export class TimelineProjection {
  #cache = new Map<TimelineRow, ProjectedRow | null>();

  project(rows: readonly TimelineRow[]): readonly AlloTimelineItem[] {
    const previous = this.#cache;
    const next = new Map<TimelineRow, ProjectedRow | null>();
    const projected: ProjectedRow[] = [];

    for (const row of rows) {
      // `null` means "read, and it is not an event"; `undefined` means "not read
      // yet". Conflating them would re-read every virtual row on every batch.
      const cached = previous.get(row);
      const value = cached === undefined ? project(row) : cached;
      next.set(row, value);
      if (value !== null) {
        projected.push(value);
      }
    }

    this.#cache = next;

    const readByOthers = markReadByOthers(projected);
    return projected.map((row, index) => row.item(readByOthers[index]));
  }
}

function project(row: TimelineRow): ProjectedRow | null {
  const event = row.asEvent();
  if (event === undefined) {
    return null;
  }
  return new ProjectedRow(toTimelineItem(row.uniqueId().id, event), toReaders(event));
}
