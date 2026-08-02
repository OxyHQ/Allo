import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MembershipState, StateEventType } from '@unomed/react-native-matrix-sdk';

import {
  readRoomDetails,
  toRights,
  type MemberFields,
  type MemberPages,
  type RoomAuthority,
  type RoomDetailsEntry,
} from '@/lib/matrix/native/roomDetails';

/**
 * Reading who is in a room on iOS and Android.
 *
 * Two things here can only be got wrong quietly. The member list arrives as a
 * *paged iterator*, so a loop that stops early reports a family group with half
 * the family missing; and permissions are asked for by an ordinal, so asking
 * about the wrong state event answers a different question with a confident
 * boolean.
 */

function member(overrides: Partial<MemberFields> = {}): MemberFields {
  return {
    userId: '@someone:allo.you',
    membership: new MembershipState.Join(),
    ...overrides,
  };
}

/** The binding's iterator: pages until it answers `undefined`. */
function pages(...chunks: readonly MemberFields[][]): MemberPages {
  let index = 0;
  return {
    nextChunk: () => (index < chunks.length ? chunks[index++] : undefined),
  };
}

function authority(overrides: Partial<Record<'invite' | 'rename', boolean>> = {}): RoomAuthority & {
  readonly asked: StateEventType[];
} {
  const asked: StateEventType[] = [];
  return {
    asked,
    canOwnUserInvite: () => overrides.invite ?? true,
    canOwnUserSendState: (stateEvent) => {
      asked.push(stateEvent);
      return overrides.rename ?? true;
    },
  };
}

function room(overrides: Partial<RoomDetailsEntry> = {}): RoomDetailsEntry {
  return {
    id: () => '!familia:allo.you',
    displayName: () => 'Familia',
    isDirect: async () => false,
    members: async () => pages([member({ userId: '@alba:allo.you', displayName: 'Alba' })]),
    getPowerLevels: async () => authority(),
    ...overrides,
  };
}

describe('readRoomDetails', () => {
  it('reports the room it was asked about', async () => {
    const details = await readRoomDetails(room());

    expect(details.roomId).toBe('!familia:allo.you');
    expect(details.name).toBe('Familia');
    expect(details.isDirect).toBe(false);
  });

  it('drains every page of the member list', async () => {
    // The iterator is the binding's only way to read it. A loop that took one
    // page would report a group with everybody after the first hundred missing,
    // and nothing on screen would say so.
    const details = await readRoomDetails(
      room({
        members: async () =>
          pages(
            [member({ userId: '@a:allo.you', displayName: 'Alba' })],
            [member({ userId: '@b:allo.you', displayName: 'Bruno' })],
            [member({ userId: '@c:allo.you', displayName: 'Carla' })],
          ),
      }),
    );

    expect(details.members.map((entry) => entry.displayName)).toEqual([
      'Alba',
      'Bruno',
      'Carla',
    ]);
  });

  it('keeps reading past an empty page', async () => {
    // The iterator ends by answering `undefined`. An empty array is not that,
    // and a loop that treated it as the end would report a room as empty
    // because of one page that happened to hold nobody.
    const details = await readRoomDetails(
      room({
        members: async () => pages([], [member({ userId: '@alba:allo.you', displayName: 'Alba' })]),
      }),
    );

    expect(details.members.map((entry) => entry.userId)).toEqual(['@alba:allo.you']);
  });

  it('keeps reading past a page of people who are no longer in the room', async () => {
    const details = await readRoomDetails(
      room({
        members: async () =>
          pages(
            [member({ userId: '@gone:allo.you', membership: new MembershipState.Leave() })],
            [member({ userId: '@alba:allo.you', displayName: 'Alba' })],
          ),
      }),
    );

    expect(details.members.map((entry) => entry.userId)).toEqual(['@alba:allo.you']);
  });

  it('reports who is in the room and who has been asked', async () => {
    const details = await readRoomDetails(
      room({
        members: async () =>
          pages([
            member({ userId: '@alba:allo.you', displayName: 'Alba' }),
            member({
              userId: '@bruno:allo.you',
              displayName: 'Bruno',
              membership: new MembershipState.Invite(),
            }),
          ]),
      }),
    );

    expect(details.members).toEqual([
      { userId: '@alba:allo.you', displayName: 'Alba', membership: 'joined' },
      { userId: '@bruno:allo.you', displayName: 'Bruno', membership: 'invited' },
    ]);
  });

  it.each([
    ['somebody who left', new MembershipState.Leave()],
    ['somebody banned', new MembershipState.Ban()],
    ['somebody knocking', new MembershipState.Knock()],
    ['a membership nobody has heard of', new MembershipState.Custom({ value: 'weird' })],
  ])('leaves out %s', async (_what, membership) => {
    // "Who is in this conversation" is not a list that includes people who are
    // not in it.
    const details = await readRoomDetails(
      room({
        members: async () => pages([member({ userId: '@nobody:allo.you', membership })]),
      }),
    );

    expect(details.members).toEqual([]);
  });

  it('treats an empty display name as no name', async () => {
    // The binding reports one for a member who has set none. Left as it comes,
    // the row draws nothing and sorts before everybody.
    const details = await readRoomDetails(
      room({
        members: async () => pages([member({ userId: '@alba:allo.you', displayName: '' })]),
      }),
    );

    expect(details.members[0].displayName).toBe(undefined);
  });

  it('orders the members it reports', async () => {
    const details = await readRoomDetails(
      room({
        members: async () =>
          pages([
            member({ userId: '@z:allo.you', displayName: 'Zoe' }),
            member({ userId: '@a:allo.you', displayName: 'Alba' }),
          ]),
      }),
    );

    expect(details.members.map((entry) => entry.displayName)).toEqual(['Alba', 'Zoe']);
  });
});

describe('toRights', () => {
  it('reports what the room’s power levels allow this account', () => {
    expect(toRights(authority({ invite: true, rename: false }))).toEqual({
      canInvite: true,
      canRename: false,
    });
    expect(toRights(authority({ invite: false, rename: true }))).toEqual({
      canInvite: false,
      canRename: true,
    });
  });

  it('asks about the state event that names a room', () => {
    // Renaming a room *is* sending `m.room.name`; there is no other permission
    // for it, and asking about a different state event answers a different
    // question with the same confident boolean.
    const levels = authority();

    toRights(levels);

    expect(levels.asked).toEqual([StateEventType.RoomName]);
  });

  it('agrees with the binding about which state event that is', () => {
    // The mock supplies these ordinals and the compiler cannot check them: they
    // are numbers, not names. This reads the binding's own declaration so that a
    // renumbering upstream fails here rather than in a room nobody can rename.
    //
    // If the package moves this file, update the path — the check is worth
    // keeping.
    const declaration = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        '..',
        'node_modules',
        '@unomed',
        'react-native-matrix-sdk',
        'lib',
        'typescript',
        'module',
        'src',
        'generated',
        'matrix_sdk_ffi.d.ts',
      ),
      'utf8',
    );
    const block = declaration.slice(declaration.indexOf('export declare enum StateEventType {'));
    const roomName = block.slice(0, block.indexOf('}')).match(/RoomName = (\d+)/);

    expect(roomName).not.toBeNull();
    expect(Number(roomName?.[1])).toBe(StateEventType.RoomName);
  });
});
