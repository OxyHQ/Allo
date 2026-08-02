import { RoomPreset, RoomVisibility_Tags } from '@unomed/react-native-matrix-sdk';

import { toCreateRoomParameters } from '@/lib/matrix/native/createRoom';
import type { AlloCreateRoomRequest } from '@/lib/matrix/types';

/**
 * The parameters a new room is created with on iOS and Android.
 *
 * The one that matters is `isEncrypted`. It is a boolean in the middle of a
 * record of eleven fields, it is one keystroke from being the opposite, and
 * getting it wrong is not recoverable: encryption in Matrix is one-way, so a
 * room created in the clear is a conversation that is permanently in the clear
 * and looks exactly like one that is not.
 *
 * So these assert the value that reaches the binding, for every shape of
 * request there is — not that a function was called.
 */

function request(overrides: Partial<AlloCreateRoomRequest> = {}): AlloCreateRoomRequest {
  return {
    invite: ['@alice:allo.you'],
    name: undefined,
    isDirect: true,
    ...overrides,
  };
}

describe('toCreateRoomParameters', () => {
  const everyShape: readonly { readonly what: string; readonly request: AlloCreateRoomRequest }[] =
    [
      { what: 'a direct message', request: request() },
      { what: 'a group', request: request({ isDirect: false, invite: ['@a:allo.you', '@b:allo.you'] }) },
      { what: 'a named group', request: request({ isDirect: false, name: 'Familia' }) },
      { what: 'a room with nobody in it', request: request({ isDirect: false, invite: [] }) },
    ];

  it.each(everyShape)('encrypts $what', ({ request: candidate }) => {
    expect(toCreateRoomParameters(candidate).isEncrypted).toBe(true);
  });

  it('keeps the room out of the public directory', () => {
    expect(toCreateRoomParameters(request()).visibility.tag).toBe(RoomVisibility_Tags.Private);
  });

  it('creates a direct message where neither person outranks the other', () => {
    expect(toCreateRoomParameters(request()).preset).toBe(RoomPreset.TrustedPrivateChat);
  });

  it('creates a group with an owner', () => {
    expect(toCreateRoomParameters(request({ isDirect: false })).preset).toBe(
      RoomPreset.PrivateChat,
    );
  });

  it('never creates a room anybody can find or join', () => {
    // Both public presets are the same mistake in different clothes, and either
    // one turns an invite-only family conversation into a room in the
    // homeserver's directory.
    for (const { request: candidate } of everyShape) {
      const parameters = toCreateRoomParameters(candidate);
      expect(parameters.preset).not.toBe(RoomPreset.PublicChat);
      expect(parameters.visibility.tag).not.toBe(RoomVisibility_Tags.Public);
    }
  });

  it('says which rooms are direct messages', () => {
    // What makes the binding write `m.direct` for the room it just made, and
    // through it what makes every client draw the other person's name instead
    // of a generated title. A direct message created without it is a two-person
    // group, permanently.
    expect(toCreateRoomParameters(request({ isDirect: true })).isDirect).toBe(true);
    expect(toCreateRoomParameters(request({ isDirect: false })).isDirect).toBe(false);
  });

  it('invites the people it was given', () => {
    expect(
      toCreateRoomParameters(request({ invite: ['@alice:allo.you', '@bob:allo.you'] })).invite,
    ).toEqual(['@alice:allo.you', '@bob:allo.you']);
  });

  it('copies the invite list rather than passing the caller’s array across the FFI', () => {
    const invite = ['@alice:allo.you'];

    expect(toCreateRoomParameters(request({ invite })).invite).not.toBe(invite);
  });

  it('names a group and leaves a direct message unnamed', () => {
    expect(toCreateRoomParameters(request({ isDirect: false, name: 'Familia' })).name).toBe(
      'Familia',
    );
    expect(toCreateRoomParameters(request({ isDirect: true, name: 'Familia' })).name).toBe(
      undefined,
    );
  });

  it('overrides none of the preset’s power levels or join rules', () => {
    // An override here replaces the whole block, including the defaults that
    // decide who may invite and who may redact, with whatever this object
    // happened to name.
    const parameters = toCreateRoomParameters(request());

    expect(parameters.powerLevelContentOverride).toBe(undefined);
    expect(parameters.joinRuleOverride).toBe(undefined);
    expect(parameters.historyVisibilityOverride).toBe(undefined);
    expect(parameters.canonicalAlias).toBe(undefined);
  });
});
