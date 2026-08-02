import { orderRoomMembers } from '@/lib/matrix/roomMembers';
import type { AlloRoomMember } from '@/lib/matrix/types';

/**
 * The order a room's members are reported in.
 *
 * Above the platform split because neither SDK has one: the binding walks its
 * store and `matrix-js-sdk` walks a map, so without this the same unchanged
 * room answers differently between two reads and the list reshuffles under the
 * reader.
 */

function member(overrides: Partial<AlloRoomMember> = {}): AlloRoomMember {
  return {
    userId: '@someone:allo.you',
    displayName: undefined,
    membership: 'joined',
    ...overrides,
  };
}

const names = (members: readonly AlloRoomMember[]): (string | undefined)[] =>
  members.map((entry) => entry.displayName ?? entry.userId);

describe('orderRoomMembers', () => {
  it('orders by the name each row draws, not by the id behind it', () => {
    // The ids here sort the opposite way from the names, which is the only
    // arrangement that tells the two apart. Allo's MXIDs are hexadecimal Oxy
    // ids, so in the app they are always in a different order from the names.
    const ordered = orderRoomMembers([
      member({ userId: '@aaa:allo.you', displayName: 'Carla' }),
      member({ userId: '@zzz:allo.you', displayName: 'Alba' }),
      member({ userId: '@mmm:allo.you', displayName: 'Bruno' }),
    ]);

    expect(names(ordered)).toEqual(['Alba', 'Bruno', 'Carla']);
  });

  it('orders somebody with no display name by the id their row shows', () => {
    // The row falls back to the user id, so the order has to as well — or the
    // list is sorted by something the reader cannot see.
    const ordered = orderRoomMembers([
      member({ userId: '@zoe:allo.you', displayName: 'Zoe' }),
      member({ userId: '@bruno:allo.you' }),
    ]);

    expect(names(ordered)).toEqual(['@bruno:allo.you', 'Zoe']);
  });

  it('does not put every capital letter before every lowercase one', () => {
    // Comparing raw strings by code point would sort `Zoe` before `alba`, which
    // reads as no order at all.
    const ordered = orderRoomMembers([
      member({ userId: '@a:allo.you', displayName: 'alba' }),
      member({ userId: '@z:allo.you', displayName: 'Zoe' }),
    ]);

    expect(names(ordered)).toEqual(['alba', 'Zoe']);
  });

  it('breaks a tie between two people with the same name', () => {
    // Matrix allows it and both SDKs report it rather than refusing, so without
    // a tiebreak these two swap places between reads.
    const ordered = orderRoomMembers([
      member({ userId: '@b:allo.you', displayName: 'Alba' }),
      member({ userId: '@a:allo.you', displayName: 'Alba' }),
    ]);

    expect(ordered.map((entry) => entry.userId)).toEqual(['@a:allo.you', '@b:allo.you']);
  });

  it('is stable: the same members in any order come out the same way', () => {
    const members = [
      member({ userId: '@c:allo.you', displayName: 'Carla' }),
      member({ userId: '@a:allo.you', displayName: 'Alba' }),
      member({ userId: '@b:allo.you' }),
    ];

    expect(names(orderRoomMembers(members))).toEqual(names(orderRoomMembers([...members].reverse())));
  });

  it('leaves the caller’s array alone', () => {
    const members = [
      member({ userId: '@z:allo.you', displayName: 'Zoe' }),
      member({ userId: '@a:allo.you', displayName: 'Alba' }),
    ];

    orderRoomMembers(members);

    expect(names(members)).toEqual(['Zoe', 'Alba']);
  });
});
