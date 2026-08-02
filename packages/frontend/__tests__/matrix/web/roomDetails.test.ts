import {
  readRoomDetails,
  toRights,
  type WebRoomDetailsSource,
  type WebRoomMember,
  type WebRoomState,
} from '@/lib/matrix/web/roomDetails';

/**
 * Reading who is in a room in a browser.
 *
 * The same answers the native half gives, from a completely different shape:
 * `matrix-js-sdk` hands over every member it has ever seen, including the ones
 * who left, and it has a display name that is not the one it looks like.
 */

const VIEWER = '@viewer:allo.you';

function member(overrides: Partial<WebRoomMember> = {}): WebRoomMember {
  return { userId: '@someone:allo.you', membership: 'join', ...overrides };
}

function state(overrides: Partial<Record<'rename', boolean>> = {}): WebRoomState & {
  readonly asked: string[];
} {
  const asked: string[] = [];
  return {
    asked,
    maySendStateEvent: (stateEventType) => {
      asked.push(stateEventType);
      return overrides.rename ?? true;
    },
  };
}

function room(overrides: Partial<WebRoomDetailsSource> = {}): WebRoomDetailsSource {
  return {
    roomId: '!familia:allo.you',
    name: 'Familia',
    getMembers: () => [member({ userId: '@alba:allo.you', rawDisplayName: 'Alba' })],
    canInvite: () => true,
    ...overrides,
  };
}

describe('readRoomDetails', () => {
  it('reports the room it was asked about', () => {
    const details = readRoomDetails(room(), state(), VIEWER, false);

    expect(details.roomId).toBe('!familia:allo.you');
    expect(details.name).toBe('Familia');
    expect(details.isDirect).toBe(false);
  });

  it('treats an empty name as no name', () => {
    // The SDK computes the name from the members when there is no `m.room.name`
    // and answers an empty string when it cannot; an empty title is not one.
    expect(readRoomDetails(room({ name: '' }), state(), VIEWER, false).name).toBe(undefined);
  });

  it('reports who is in the room and who has been asked', () => {
    const details = readRoomDetails(
      room({
        getMembers: () => [
          member({ userId: '@alba:allo.you', rawDisplayName: 'Alba' }),
          member({ userId: '@bruno:allo.you', rawDisplayName: 'Bruno', membership: 'invite' }),
        ],
      }),
      state(),
      VIEWER,
      false,
    );

    expect(details.members).toEqual([
      { userId: '@alba:allo.you', displayName: 'Alba', membership: 'joined' },
      { userId: '@bruno:allo.you', displayName: 'Bruno', membership: 'invited' },
    ]);
  });

  it.each(['leave', 'ban', 'knock', 'something-else', undefined])(
    'leaves out a member whose membership is %s',
    (membership) => {
      // `getMembers()` answers with everybody the room has ever held. Left
      // unfiltered, "who is in this conversation" would list the people who are
      // not — including whoever was removed from a family group.
      const details = readRoomDetails(
        room({ getMembers: () => [member({ membership })] }),
        state(),
        VIEWER,
        false,
      );

      expect(details.members).toEqual([]);
    },
  );

  it('treats a member with no display name as having none', () => {
    // `rawDisplayName` and not `name`: the SDK's `name` falls back to the user
    // id, so reading it would report a name where the port promised none — and
    // the row would draw an MXID as if somebody had chosen it.
    const details = readRoomDetails(
      room({ getMembers: () => [member({ userId: '@alba:allo.you' })] }),
      state(),
      VIEWER,
      false,
    );

    expect(details.members[0].displayName).toBe(undefined);
  });

  it('orders the members it reports', () => {
    const details = readRoomDetails(
      room({
        getMembers: () => [
          member({ userId: '@z:allo.you', rawDisplayName: 'Zoe' }),
          member({ userId: '@a:allo.you', rawDisplayName: 'Alba' }),
        ],
      }),
      state(),
      VIEWER,
      false,
    );

    expect(details.members.map((entry) => entry.displayName)).toEqual(['Alba', 'Zoe']);
  });

  it('says when the conversation is a direct message', () => {
    // Read from `m.direct` by the caller: a room is not marked direct in its own
    // state, so there is nothing here to read it from.
    expect(readRoomDetails(room(), state(), VIEWER, true).isDirect).toBe(true);
  });
});

describe('toRights', () => {
  it('asks the room about this viewer and nobody else', () => {
    const asked: string[] = [];
    const rights = toRights(
      room({
        canInvite: (userId) => {
          asked.push(userId);
          return true;
        },
      }),
      state(),
      VIEWER,
    );

    expect(asked).toEqual([VIEWER]);
    expect(rights.canInvite).toBe(true);
  });

  it('asks about the state event that names a room', () => {
    const roomState = state();

    toRights(room(), roomState, VIEWER);

    expect(roomState.asked).toEqual(['m.room.name']);
  });

  it('reports what the room’s power levels refuse', () => {
    expect(toRights(room({ canInvite: () => false }), state({ rename: false }), VIEWER)).toEqual({
      canInvite: false,
      canRename: false,
    });
  });
});
