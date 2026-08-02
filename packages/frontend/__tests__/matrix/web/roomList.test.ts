import {
  directRoomIds,
  orderRoomList,
  selectRoomPreview,
  type RoomListEntry,
} from '@/lib/matrix/web/roomList';
import type { AlloRoomSummary } from '@/lib/matrix/types';
import type { TimelineEventFields } from '@/lib/matrix/web/translate';

/**
 * The order of the conversation list, the message each row previews, and the
 * account data that decides which of its rows are direct messages.
 *
 * `matrix-js-sdk` hands over an unordered set of rooms and no notion of a room's
 * latest message, where the Rust SDK hands over both, so this is the code that
 * has to produce the list the native half gets for free.
 */

const VIEWER = '@viewer:allo.you';

function summary(roomId: string): AlloRoomSummary {
  return {
    roomId,
    displayName: roomId,
    avatarUrl: undefined,
    isDirect: false,
    membership: 'joined',
    encryption: 'encrypted',
    unreadCount: 0,
    latestMessage: undefined,
  };
}

function entry(roomId: string, activityTimestamp: number): RoomListEntry {
  return { summary: summary(roomId), activityTimestamp };
}

/** A timeline event, described by the members the preview reads. */
function event(type: string, body: string, sentAt = 1_700_000_000_000): TimelineEventFields {
  return {
    getId: () => `$${body}`,
    getTxnId: () => undefined,
    getSender: () => '@alice:allo.you',
    getType: () => type,
    getContent: () => ({ msgtype: 'm.text', body }),
    getTs: () => sentAt,
    isRedacted: () => false,
    replacingEvent: () => null,
    status: null,
    sender: { name: 'Alice' },
  };
}

/** `count` events of a type no row can preview. */
function noise(count: number): TimelineEventFields[] {
  return Array.from({ length: count }, (_unused, index) =>
    event('m.room.member', `joined-${index}`),
  );
}

describe('orderRoomList', () => {
  it('puts the most recently active conversation first', () => {
    const ordered = orderRoomList([
      entry('!quiet:allo.you', 1_000),
      entry('!loud:allo.you', 3_000),
      entry('!middling:allo.you', 2_000),
    ]);

    expect(ordered.map((room) => room.roomId)).toEqual([
      '!loud:allo.you',
      '!middling:allo.you',
      '!quiet:allo.you',
    ]);
  });

  it('orders rooms with the same timestamp the same way whatever order they arrive in', () => {
    // The input order is whatever getRooms() returned this time. Without a
    // tie-break, two rooms with one timestamp swap places between rebuilds and
    // the list jumps under the user's finger.
    const forwards = orderRoomList([entry('!a:allo.you', 5), entry('!b:allo.you', 5)]);
    const backwards = orderRoomList([entry('!b:allo.you', 5), entry('!a:allo.you', 5)]);

    expect(forwards.map((room) => room.roomId)).toEqual(backwards.map((room) => room.roomId));
  });

  it('sorts a room the SDK holds no events for last', () => {
    // Which is what Number.MIN_SAFE_INTEGER is for, and why the comparison is
    // arithmetic rather than a truthiness check.
    const ordered = orderRoomList([
      entry('!empty:allo.you', Number.MIN_SAFE_INTEGER),
      entry('!busy:allo.you', 1),
    ]);

    expect(ordered.map((room) => room.roomId)).toEqual(['!busy:allo.you', '!empty:allo.you']);
  });

  it('leaves the array it was given alone', () => {
    const entries = [entry('!a:allo.you', 1), entry('!b:allo.you', 2)];

    orderRoomList(entries);

    expect(entries.map((item) => item.summary.roomId)).toEqual(['!a:allo.you', '!b:allo.you']);
  });
});

describe('selectRoomPreview', () => {
  it('previews the newest message in the room', () => {
    const preview = selectRoomPreview(
      [event('m.room.message', 'older'), event('m.room.message', 'newest')],
      VIEWER,
    );

    expect(preview?.content).toEqual({ kind: 'text', body: 'newest', isEdited: false });
  });

  it('walks past events that are not messages to the last one that is', () => {
    // The reason this function exists rather than a call to getLastLiveEvent().
    // Someone joining a room is not the room's latest message, and a list that
    // said so would lose every preview the moment anybody came or went.
    const preview = selectRoomPreview(
      [event('m.room.message', 'the real last message'), ...noise(3)],
      VIEWER,
    );

    expect(preview?.content).toEqual({
      kind: 'text',
      body: 'the real last message',
      isEdited: false,
    });
  });

  it('has no preview for a room whose timeline this device holds nothing of', () => {
    // An invitation, and a room created a second ago. Not an empty preview and
    // above all not a time: `undefined` is what stops a row inventing one.
    expect(selectRoomPreview([], VIEWER)).toBe(undefined);
  });

  it('has no preview for a room that holds no messages at all', () => {
    expect(selectRoomPreview(noise(5), VIEWER)).toBe(undefined);
  });

  it('gives up rather than walking a long history of events it cannot preview', () => {
    // The list is rebuilt on every sync response and this search is per room, so
    // it is bounded. Giving up costs a row its preview; not bounding it costs
    // every room's whole loaded history, several times a minute.
    const deep = [event('m.room.message', 'buried'), ...noise(40)];

    expect(selectRoomPreview(deep, VIEWER)).toBe(undefined);
  });

  it('reads the time from the message it previews and not from any other event', () => {
    const preview = selectRoomPreview(
      [
        event('m.room.message', 'the message', 1_600_000_000_000),
        event('m.room.member', 'joined', 1_700_000_000_000),
      ],
      VIEWER,
    );

    expect(preview?.sentAt).toBe(1_600_000_000_000);
  });
});

describe('directRoomIds', () => {
  it('collects every room shared with every user', () => {
    const ids = directRoomIds({
      '@alice:allo.you': ['!one:allo.you', '!two:allo.you'],
      '@bob:allo.you': ['!three:allo.you'],
    });

    expect([...ids].sort()).toEqual(['!one:allo.you', '!three:allo.you', '!two:allo.you']);
  });

  it('has nothing to say about an account that has never marked a direct message', () => {
    expect(directRoomIds(undefined).size).toBe(0);
  });

  it('ignores entries that are not what the event promises', () => {
    // Written by every client the user has ever used. A malformed entry costs a
    // room its avatar; trusting it costs a crash in the conversation list.
    const ids = directRoomIds({
      '@alice:allo.you': '!not-an-array:allo.you',
      '@bob:allo.you': [42, '!real:allo.you', null],
      '@carol:allo.you': null,
    });

    expect([...ids]).toEqual(['!real:allo.you']);
  });
});
