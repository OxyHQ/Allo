import { directRoomIds, orderRoomList, type RoomListEntry } from '@/lib/matrix/web/roomList';
import type { AlloRoomSummary } from '@/lib/matrix/types';

/**
 * The order of the conversation list, and the account data that decides which of
 * its rows are direct messages.
 *
 * `matrix-js-sdk` hands over an unordered set of rooms where the Rust SDK hands
 * over a sorted list, so this is the code that has to produce the same list the
 * native half gets for free.
 */

function summary(roomId: string): AlloRoomSummary {
  return {
    roomId,
    displayName: roomId,
    avatarUrl: undefined,
    isDirect: false,
    membership: 'joined',
    encryption: 'encrypted',
    unreadCount: 0,
  };
}

function entry(roomId: string, activityTimestamp: number): RoomListEntry {
  return { summary: summary(roomId), activityTimestamp };
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
