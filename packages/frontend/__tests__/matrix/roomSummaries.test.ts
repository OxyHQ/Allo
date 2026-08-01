import { EncryptionState, Membership } from '@unomed/react-native-matrix-sdk';

import { RoomSummaryCache, type RoomEntry } from '@/lib/matrix/native/roomSummaries';
import type { RoomSummaryFields } from '@/lib/matrix/native/translate';

jest.mock('@unomed/react-native-matrix-sdk');

/**
 * A room, unlike a timeline row, does not carry its summary: reading one is an
 * async call across the FFI boundary. The room list stream emits a batch whenever
 * any conversation changes, so re-reading every room per batch would cost one
 * round trip per conversation per message received by anyone.
 */

interface CountedRoom extends RoomEntry {
  readonly reads: () => number;
}

function room(id: string, overrides: Partial<RoomSummaryFields> = {}): CountedRoom {
  let reads = 0;
  return {
    roomInfo: async () => {
      reads += 1;
      return {
        id,
        displayName: id,
        avatarUrl: undefined,
        isDirect: true,
        membership: Membership.Joined,
        encryptionState: EncryptionState.Encrypted,
        numUnreadMessages: 0n,
        ...overrides,
      };
    },
    reads: () => reads,
  };
}

describe('RoomSummaryCache', () => {
  it('keeps the order the room list gave it', async () => {
    const cache = new RoomSummaryCache();

    const summaries = await cache.project([room('!b'), room('!a'), room('!c')]);

    expect(summaries.map((summary) => summary.roomId)).toEqual(['!b', '!a', '!c']);
  });

  it('reads each room once, however many batches go by', async () => {
    const cache = new RoomSummaryCache();
    const first = room('!first');
    const second = room('!second');

    await cache.project([first]);
    await cache.project([first, second]);
    await cache.project([second, first]);

    expect(first.reads()).toBe(1);
    expect(second.reads()).toBe(1);
  });

  it('re-reads a room the SDK replaced', async () => {
    // A new message in a conversation arrives as a fresh room object, and its
    // unread count has to be read again — serving the cached one is how a badge
    // gets stuck.
    const cache = new RoomSummaryCache();
    const before = room('!room', { numUnreadMessages: 0n });
    const after = room('!room', { numUnreadMessages: 2n });

    expect((await cache.project([before]))[0]?.unreadCount).toBe(0);
    expect((await cache.project([after]))[0]?.unreadCount).toBe(2);
  });

  it('forgets rooms that have left the list', async () => {
    const cache = new RoomSummaryCache();
    const left = room('!room');

    await cache.project([left]);
    await cache.project([]);
    await cache.project([left]);

    expect(left.reads()).toBe(2);
  });

  it('reports an empty room list as an empty list', async () => {
    expect(await new RoomSummaryCache().project([])).toEqual([]);
  });

  it('translates what it read', async () => {
    const cache = new RoomSummaryCache();

    const summaries = await cache.project([
      room('!room', {
        displayName: 'Bea',
        encryptionState: EncryptionState.Unknown,
        numUnreadMessages: 5n,
        membership: Membership.Invited,
      }),
    ]);

    expect(summaries[0]).toEqual({
      roomId: '!room',
      displayName: 'Bea',
      avatarUrl: undefined,
      isDirect: true,
      membership: 'invited',
      encryption: 'unknown',
      unreadCount: 5,
    });
  });
});
