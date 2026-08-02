import { EventOrTransactionId, ProfileDetails, TimelineItemContent, MsgLikeKind, MessageType } from '@unomed/react-native-matrix-sdk';

import {
  TimelineProjection,
  type TimelineRow,
} from '@/lib/matrix/native/timelineProjection';
import type { TimelineEventFields } from '@/lib/matrix/native/translate';

jest.mock('@unomed/react-native-matrix-sdk');

/**
 * The projection turns the array that mirrors Rust's timeline into the array the
 * UI draws. Two things it has to get right, and neither is a `map`:
 *
 * - rows that are not events are dropped here and not from the mirrored list,
 *   because the SDK's diffs address that list by index;
 * - reading a row costs two calls across the FFI boundary, and a batch arrives on
 *   every event received, so rows already read must not be read again.
 */

interface EventOptions {
  readonly sender?: string;
  readonly readers?: readonly string[];
}

function eventFields(body: string, options: EventOptions = {}): TimelineEventFields {
  return {
    eventOrTransactionId: new EventOrTransactionId.EventId({ eventId: `$${body}` }),
    sender: options.sender ?? '@alice:allo.you',
    senderProfile: new ProfileDetails.Unavailable(),
    content: new TimelineItemContent.MsgLike({
      content: {
        kind: new MsgLikeKind.Message({
          content: {
            msgType: new MessageType.Text({ content: { body } }),
            body,
            isEdited: false,
          },
        }),
        reactions: [],
      },
    }),
    timestamp: 1_700_000_000_000n,
    isOwn: false,
    localSendState: undefined,
    readReceipts: new Map(
      (options.readers ?? []).map((userId) => [userId, { timestamp: 1_700_000_000_000n }]),
    ),
  };
}

interface CountedRow extends TimelineRow {
  readonly reads: () => number;
}

function eventRow(id: string, body: string, options: EventOptions = {}): CountedRow {
  let reads = 0;
  return {
    uniqueId: () => ({ id }),
    asEvent: () => {
      reads += 1;
      return eventFields(body, options);
    },
    reads: () => reads,
  };
}

/** A date separator or the read marker: a row that is not an event. */
function virtualRow(id: string): CountedRow {
  let reads = 0;
  return {
    uniqueId: () => ({ id }),
    asEvent: () => {
      reads += 1;
      return undefined;
    },
    reads: () => reads,
  };
}

describe('TimelineProjection', () => {
  it('draws the events in the order the mirrored list holds them', () => {
    const projection = new TimelineProjection();

    const items = projection.project([
      eventRow('row-1', 'first'),
      eventRow('row-2', 'second'),
    ]);

    expect(items.map((item) => item.content)).toEqual([
      { kind: 'text', body: 'first', isEdited: false },
      { kind: 'text', body: 'second', isEdited: false },
    ]);
    expect(items.map((item) => item.key)).toEqual(['row-1', 'row-2']);
  });

  it('leaves out the rows that are not events', () => {
    const projection = new TimelineProjection();

    const items = projection.project([
      virtualRow('separator'),
      eventRow('row-1', 'first'),
      virtualRow('read-marker'),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0]?.key).toBe('row-1');
  });

  it('reads each row once, however many batches go by', () => {
    const projection = new TimelineProjection();
    const first = eventRow('row-1', 'first');
    const second = eventRow('row-2', 'second');

    projection.project([first]);
    projection.project([first, second]);
    projection.project([first, second]);

    expect(first.reads()).toBe(1);
    expect(second.reads()).toBe(1);
  });

  it('does not re-read a row that is not an event either', () => {
    // Caching only the events would leave every date separator being read again
    // on every single batch.
    const projection = new TimelineProjection();
    const separator = virtualRow('separator');

    projection.project([separator]);
    projection.project([separator]);

    expect(separator.reads()).toBe(1);
  });

  it('hands back the same item object for a row that has not changed', () => {
    // React's memoisation is keyed on this: a new object for an unchanged message
    // redraws every row in the conversation on every event received.
    const projection = new TimelineProjection();
    const row = eventRow('row-1', 'first');

    const before = projection.project([row]);
    const after = projection.project([row]);

    expect(after[0]).toBe(before[0]);
  });

  it('re-reads a row the SDK replaced', () => {
    // A local echo becoming a remote event, or an edit: the binding hands over a
    // fresh object, and that is the signal that the content changed.
    const projection = new TimelineProjection();
    const pending = eventRow('row-1', 'draft');
    const settled = eventRow('row-1', 'sent');

    const before = projection.project([pending]);
    const after = projection.project([settled]);

    expect(before[0]?.content).toEqual({ kind: 'text', body: 'draft', isEdited: false });
    expect(after[0]?.content).toEqual({ kind: 'text', body: 'sent', isEdited: false });
  });

  it('forgets rows that have left the timeline', () => {
    // Otherwise the cache is a leak that grows for as long as the conversation is
    // open, holding on to every message ever paginated in.
    const projection = new TimelineProjection();
    const row = eventRow('row-1', 'first');

    projection.project([row]);
    projection.project([]);
    projection.project([row]);

    expect(row.reads()).toBe(2);
  });

  it('reports an empty timeline as an empty list', () => {
    expect(new TimelineProjection().project([])).toEqual([]);
  });
});

describe('TimelineProjection read receipts', () => {
  const BEA = '@bea:allo.you';

  it('marks the rows before the one a receipt names', () => {
    // The binding attaches a receipt to the single event it names. Reading each
    // row on its own would report every message but the last as unread.
    const projection = new TimelineProjection();

    const items = projection.project([
      eventRow('row-1', 'first'),
      eventRow('row-2', 'second', { readers: [BEA] }),
    ]);

    expect(items.map((item) => item.isReadByOthers)).toEqual([true, true]);
  });

  it('leaves the rows after the receipt unread', () => {
    const projection = new TimelineProjection();

    const items = projection.project([
      eventRow('row-1', 'first', { readers: [BEA] }),
      eventRow('row-2', 'second'),
    ]);

    expect(items.map((item) => item.isReadByOthers)).toEqual([true, false]);
  });

  it('moves the mark forward when only the row the receipt moved to changed', () => {
    // The reason the scan cannot be folded into the per-row cache. When a reader
    // moves on, the binding hands over new objects for the two rows the receipt
    // left and arrived at — and for nothing in between, whose answer changed all
    // the same. Caching the finished item against the row object would leave the
    // middle of the conversation reporting the old answer for good.
    const projection = new TimelineProjection();
    const middle = eventRow('row-2', 'second');
    projection.project([
      eventRow('row-1', 'first', { readers: [BEA] }),
      middle,
      eventRow('row-3', 'third'),
    ]);

    const after = projection.project([
      eventRow('row-1', 'first'),
      middle,
      eventRow('row-3', 'third', { readers: [BEA] }),
    ]);

    expect(after.map((item) => item.isReadByOthers)).toEqual([true, true, true]);
  });

  it('does not read the unchanged row again to move its mark', () => {
    // The mark moved without an FFI call, which is the point of doing it in a
    // second pass: a receipt arriving must not cost a round trip per message in
    // the window.
    const projection = new TimelineProjection();
    const middle = eventRow('row-2', 'second');
    projection.project([middle, eventRow('row-3', 'third')]);

    projection.project([middle, eventRow('row-3', 'third', { readers: [BEA] })]);

    expect(middle.reads()).toBe(1);
  });

  it('hands back the same item object while the mark has not changed', () => {
    const projection = new TimelineProjection();
    const row = eventRow('row-1', 'first', { readers: [BEA] });

    const before = projection.project([row]);
    const after = projection.project([row]);

    expect(after[0]).toBe(before[0]);
  });

  it('does not count the sender reading their own message', () => {
    const projection = new TimelineProjection();

    const items = projection.project([
      eventRow('row-1', 'first', { sender: BEA, readers: [BEA] }),
    ]);

    expect(items[0]?.isReadByOthers).toBe(false);
  });
});
