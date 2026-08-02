import {
  EncryptionState,
  Membership,
  MessageType,
  MsgLikeKind,
  ProfileDetails,
  TimelineItemContent,
} from '@unomed/react-native-matrix-sdk';

import { RoomSummaryCache, type RoomEntry } from '@/lib/matrix/native/roomSummaries';
import type { RoomPreviewFields, RoomSummaryFields } from '@/lib/matrix/native/translate';

jest.mock('@unomed/react-native-matrix-sdk');

/**
 * A room, unlike a timeline row, does not carry its summary: reading one is two
 * async calls across the FFI boundary. The room list stream emits a batch
 * whenever any conversation changes, so re-reading every room per batch would
 * cost two round trips per conversation per message received by anyone.
 */

interface CountedRoom extends RoomEntry {
  readonly reads: () => number;
}

function message(body: string): RoomPreviewFields['content'] {
  return new TimelineItemContent.MsgLike({
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
  });
}

function latestEvent(overrides: Partial<RoomPreviewFields> = {}): RoomPreviewFields {
  return {
    sender: '@alice:allo.you',
    senderProfile: new ProfileDetails.Unavailable(),
    content: message('hello'),
    timestamp: 1_700_000_000_000n,
    isOwn: false,
    ...overrides,
  };
}

interface RoomOptions {
  readonly info?: Partial<RoomSummaryFields>;
  /** The room's latest event: absent by default, as an untouched room's is. */
  readonly latest?: RoomPreviewFields;
  /** Makes `latestEvent()` reject, as it does for a room the store cannot read. */
  readonly latestFails?: boolean;
}

function room(id: string, options: RoomOptions = {}): CountedRoom {
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
        ...options.info,
      };
    },
    latestEvent: async () => {
      if (options.latestFails === true) {
        throw new Error('the event cache has nothing for this room');
      }
      return options.latest;
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
    const before = room('!room', { info: { numUnreadMessages: 0n } });
    const after = room('!room', { info: { numUnreadMessages: 2n } });

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
        info: {
          displayName: 'Bea',
          encryptionState: EncryptionState.Unknown,
          numUnreadMessages: 5n,
          membership: Membership.Invited,
        },
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
      latestMessage: undefined,
    });
  });

  it("carries the room's latest message and the time it was sent", async () => {
    const cache = new RoomSummaryCache();

    const summaries = await cache.project([
      room('!room', {
        latest: latestEvent({ content: message('see you there'), timestamp: 1_600_000_000_000n }),
      }),
    ]);

    expect(summaries[0]?.latestMessage).toEqual({
      sentAt: 1_600_000_000_000,
      sender: '@alice:allo.you',
      senderDisplayName: undefined,
      isOwn: false,
      content: { kind: 'text', body: 'see you there', isEdited: false },
    });
  });

  it('gives a room nobody has written in no preview and no time', async () => {
    // An invitation, and a room created a second ago. `undefined` is the answer
    // that lets the row say nothing; anything else would be a time invented here.
    const summaries = await new RoomSummaryCache().project([room('!fresh')]);

    expect(summaries[0]?.latestMessage).toBe(undefined);
  });

  it('keeps a room whose latest message could not be read', async () => {
    // The row still has a name, an avatar and an unread count. Losing the whole
    // conversation list because one room's last message could not be fetched
    // would be a far worse answer than one row without a preview.
    const summaries = await new RoomSummaryCache().project([
      room('!broken', { latestFails: true }),
      room('!fine', { latest: latestEvent() }),
    ]);

    expect(summaries.map((summary) => summary.roomId)).toEqual(['!broken', '!fine']);
    expect(summaries[0]?.latestMessage).toBe(undefined);
    expect(summaries[1]?.latestMessage).toBeDefined();
  });
});
