import { soleDirectInvitee } from '@/lib/matrix/directMessage';
import type { AlloCreateRoomRequest } from '@/lib/matrix/types';

/**
 * When creating a conversation means reusing one.
 *
 * The rule is above the platform split because the two halves look the existing
 * room up in completely different ways and must still agree on *when* to look. If
 * they drift, the same tap opens the conversation the user already had on one
 * platform and starts a second one on the other — two threads of history that
 * neither person can see from the other.
 */

function request(overrides: Partial<AlloCreateRoomRequest> = {}): AlloCreateRoomRequest {
  return {
    invite: ['@alice:allo.you'],
    name: undefined,
    isDirect: true,
    ...overrides,
  };
}

describe('soleDirectInvitee', () => {
  it('names the person a direct message is with', () => {
    expect(soleDirectInvitee(request())).toBe('@alice:allo.you');
  });

  it('has nobody to look up for a group', () => {
    // A group is a new room every time it is asked for. Two groups with the same
    // members are two different conversations, and the user meant the new one.
    expect(soleDirectInvitee(request({ isDirect: false }))).toBe(undefined);
  });

  it('has nobody to look up for a room with two people invited', () => {
    // `m.direct` records one room per person. Three people cannot share a
    // conversation that every client resolves to a pair, so there is no room to
    // find however the caller labelled the request.
    expect(
      soleDirectInvitee(request({ invite: ['@alice:allo.you', '@bob:allo.you'] })),
    ).toBe(undefined);
  });

  it('has nobody to look up for a room the user is alone in', () => {
    expect(soleDirectInvitee(request({ invite: [] }))).toBe(undefined);
  });
});
