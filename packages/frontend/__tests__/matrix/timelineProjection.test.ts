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

function eventFields(body: string): TimelineEventFields {
  return {
    eventOrTransactionId: new EventOrTransactionId.EventId({ eventId: `$${body}` }),
    sender: '@alice:allo.you',
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
  };
}

interface CountedRow extends TimelineRow {
  readonly reads: () => number;
}

function eventRow(id: string, body: string): CountedRow {
  let reads = 0;
  return {
    uniqueId: () => ({ id }),
    asEvent: () => {
      reads += 1;
      return eventFields(body);
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
