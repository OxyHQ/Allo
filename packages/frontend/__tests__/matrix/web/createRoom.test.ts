import {
  MEGOLM_ALGORITHM,
  ROOM_ENCRYPTION_EVENT_TYPE,
  ROOM_ENCRYPTION_STATE_KEY,
} from '@/lib/matrix/roomCreation';
import { toCreateRoomOptions } from '@/lib/matrix/web/createRoom';
import type { AlloCreateRoomRequest } from '@/lib/matrix/types';

/**
 * The options a new room is created with in a browser.
 *
 * The asymmetry with the native half is the whole reason this module exists.
 * The Rust binding takes `isEncrypted: true`; `matrix-js-sdk` takes nothing of
 * the sort, and a `createRoom` without an `m.room.encryption` event in
 * `initial_state` succeeds, syncs and draws identically to one with it. The
 * only difference is that the homeserver can read every message in it, forever,
 * because encryption in Matrix cannot be turned on afterwards.
 *
 * So these read the options rather than trusting that a function was called.
 */

function request(overrides: Partial<AlloCreateRoomRequest> = {}): AlloCreateRoomRequest {
  return {
    invite: ['@alice:allo.you'],
    name: undefined,
    isDirect: true,
    ...overrides,
  };
}

/** The encryption event in a set of options, if there is one at all. */
function encryptionEvent(request: AlloCreateRoomRequest): unknown {
  return toCreateRoomOptions(request).initial_state?.find(
    (event) => event.type === ROOM_ENCRYPTION_EVENT_TYPE,
  );
}

describe('toCreateRoomOptions', () => {
  const everyShape: readonly { readonly what: string; readonly request: AlloCreateRoomRequest }[] =
    [
      { what: 'a direct message', request: request() },
      { what: 'a group', request: request({ isDirect: false, invite: ['@a:allo.you', '@b:allo.you'] }) },
      { what: 'a named group', request: request({ isDirect: false, name: 'Familia' }) },
      { what: 'a room with nobody in it', request: request({ isDirect: false, invite: [] }) },
    ];

  it.each(everyShape)('encrypts $what', ({ request: candidate }) => {
    expect(encryptionEvent(candidate)).toEqual({
      type: ROOM_ENCRYPTION_EVENT_TYPE,
      state_key: ROOM_ENCRYPTION_STATE_KEY,
      content: { algorithm: MEGOLM_ALGORITHM },
    });
  });

  it('asks for the only algorithm rooms have', () => {
    // A room whose `m.room.encryption` names an algorithm no client implements
    // is a room in which nothing can be decrypted — the padlock is there and
    // the messages are not.
    expect(MEGOLM_ALGORITHM).toBe('m.megolm.v1.aes-sha2');
  });

  it('puts the encryption event at the room’s own state key', () => {
    // `m.room.encryption` is a property of the room, so its state key is empty.
    // An event under any other key is not the room's encryption event and the
    // homeserver treats the room as unencrypted.
    expect(ROOM_ENCRYPTION_STATE_KEY).toBe('');
  });

  it('says which rooms are direct messages', () => {
    // `is_direct` is what makes the homeserver mark the invitation as a DM for
    // the person receiving it, which is a different fact from the `m.direct`
    // account data the creating client writes for itself.
    expect(toCreateRoomOptions(request({ isDirect: true })).is_direct).toBe(true);
    expect(toCreateRoomOptions(request({ isDirect: false })).is_direct).toBe(false);
  });

  it('invites the people it was given', () => {
    expect(
      toCreateRoomOptions(request({ invite: ['@alice:allo.you', '@bob:allo.you'] })).invite,
    ).toEqual(['@alice:allo.you', '@bob:allo.you']);
  });

  it('copies the invite list rather than serialising the caller’s array', () => {
    const invite = ['@alice:allo.you'];

    expect(toCreateRoomOptions(request({ invite })).invite).not.toBe(invite);
  });

  it('names a group and leaves a direct message unnamed', () => {
    expect(toCreateRoomOptions(request({ isDirect: false, name: 'Familia' })).name).toBe(
      'Familia',
    );
    expect(toCreateRoomOptions(request({ isDirect: true, name: 'Familia' })).name).toBe(undefined);
  });
});
