import { roomNameFor, roomPresetFor } from '@/lib/matrix/roomCreation';
import type { AlloCreateRoomRequest } from '@/lib/matrix/types';

/**
 * What every room Allo creates is, decided once for both platforms.
 *
 * These rules are above the platform split for the same reason
 * `soleDirectInvitee` is: the two halves build different objects out of them,
 * and a disagreement means the same tap makes a different conversation on a
 * phone than it does in a browser.
 */

function request(overrides: Partial<AlloCreateRoomRequest> = {}): AlloCreateRoomRequest {
  return {
    invite: ['@alice:allo.you'],
    name: undefined,
    isDirect: true,
    ...overrides,
  };
}

describe('roomPresetFor', () => {
  it('gives both people the same power in a direct message', () => {
    // A conversation between two people has no moderator. `PrivateChat` would
    // leave the creator able to rename the room and remove the other person,
    // and the other person able to do neither.
    expect(roomPresetFor(request())).toBe('trusted-private-chat');
  });

  it('leaves a group with an owner', () => {
    expect(roomPresetFor(request({ isDirect: false }))).toBe('private-chat');
  });
});

describe('roomNameFor', () => {
  it('names a group what the user called it', () => {
    expect(roomNameFor(request({ isDirect: false, name: 'Familia' }))).toBe('Familia');
  });

  it('gives a direct message no name', () => {
    // Every client draws a one-to-one room with the other person's name. A name
    // written here would be a title nobody asked for — and, because room state
    // is not encrypted, two people's names in the clear on the homeserver.
    expect(roomNameFor(request({ isDirect: true, name: 'Alice and me' }))).toBe(undefined);
  });

  it('trims the name it is given', () => {
    expect(roomNameFor(request({ isDirect: false, name: '  Familia  ' }))).toBe('Familia');
  });

  it('treats a name of nothing but spaces as no name', () => {
    // A room whose title is blank in every client reads as a bug rather than as
    // a choice, and there is no way to tell it apart from one afterwards.
    expect(roomNameFor(request({ isDirect: false, name: '   ' }))).toBe(undefined);
  });

  it('has no name for a group nobody named', () => {
    expect(roomNameFor(request({ isDirect: false }))).toBe(undefined);
  });
});
