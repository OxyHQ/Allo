import {
  decodeStoreOwner,
  encodeStoreOwner,
  sameStoreOwner,
  storeOwnerOf,
  STORE_OWNER_VERSION,
  type MatrixStoreOwner,
} from '@/lib/chat/matrixStoreOwner';
import type { AlloSession } from '@/lib/matrix/types';

/**
 * The record that says whose the client's store on disk is.
 *
 * Small enough to read in one go and worth testing anyway, because everything
 * `matrixRuntime` does with the store hangs off the one boolean
 * {@link sameStoreOwner} answers. Get it wrong in the permissive direction and
 * the account switching onto this device opens the last account's keys; get it
 * wrong in the strict direction and every launch erases a store it should have
 * kept and mints a new Matrix device.
 */

const OWNER: MatrixStoreOwner = {
  userId: '@nate:matrix.example',
  deviceId: 'DEVICE',
  homeserverUrl: 'https://matrix.example',
};

const SESSION: AlloSession = {
  ...OWNER,
  accessToken: 'secret-access-token',
  refreshToken: 'secret-refresh-token',
  authData: 'opaque',
};

describe('storeOwnerOf', () => {
  it('takes the identity out of a session and nothing else', () => {
    // Specifically not the tokens. This record is written to AsyncStorage, which
    // on web is `localStorage`, and the session's tokens live in the keychain for
    // a reason.
    expect(storeOwnerOf(SESSION)).toEqual(OWNER);
  });

  it('carries no part of the session’s credentials into what is written', () => {
    expect(encodeStoreOwner(storeOwnerOf(SESSION))).not.toContain('secret-');
  });
});

describe('sameStoreOwner', () => {
  it('matches an identity against itself', () => {
    expect(sameStoreOwner(OWNER, { ...OWNER })).toBe(true);
  });

  it.each([
    ['user', { userId: '@lena:matrix.example' }],
    ['device', { deviceId: 'OTHERDEVICE' }],
    ['homeserver', { homeserverUrl: 'https://elsewhere.example' }],
  ])('refuses a record that differs by %s', (_field, difference) => {
    // All three, and each on its own. The device id is the one most easily left
    // out: two sessions for the same person on the same homeserver are still two
    // devices, and the keys in the store belong to one of them.
    expect(sameStoreOwner(OWNER, { ...OWNER, ...difference })).toBe(false);
  });

  it('treats nobody as matching nobody', () => {
    // An unrecorded store and a launch with no session are both "nobody", and
    // calling that a match would skip the erase in the one case most likely to
    // have something left over on disk.
    expect(sameStoreOwner(undefined, undefined)).toBe(false);
  });

  it('refuses an identity against nobody, in either direction', () => {
    expect(sameStoreOwner(OWNER, undefined)).toBe(false);
    expect(sameStoreOwner(undefined, OWNER)).toBe(false);
  });
});

describe('decodeStoreOwner', () => {
  it('reads back what encode wrote', () => {
    expect(decodeStoreOwner(encodeStoreOwner(OWNER))).toEqual(OWNER);
  });

  it.each([
    ['nothing at all', undefined],
    ['a key that is not there', null],
    ['an empty string', ''],
    ['something that is not JSON', 'not json'],
    ['something that is not an object', '"a string"'],
    ['null', 'null'],
    ['a version this build does not write', `{"version":${STORE_OWNER_VERSION + 1}}`],
    ['a record naming no user', `{"version":${STORE_OWNER_VERSION},"deviceId":"D","homeserverUrl":"h"}`],
    ['a record naming no device', `{"version":${STORE_OWNER_VERSION},"userId":"@n:h","homeserverUrl":"h"}`],
    [
      'a record naming no homeserver',
      `{"version":${STORE_OWNER_VERSION},"userId":"@n:h","deviceId":"D"}`,
    ],
    [
      'a record whose fields are not strings',
      `{"version":${STORE_OWNER_VERSION},"userId":1,"deviceId":2,"homeserverUrl":3}`,
    ],
  ])('answers nobody for %s', (_case, raw) => {
    // Every one of these ends the same way at the caller — the store is erased —
    // so there is nothing to gain from telling them apart. What matters is that
    // none of them is ever read as an owner, because being read as an owner is
    // what would let a store be adopted by the wrong identity.
    expect(decodeStoreOwner(raw)).toBeUndefined();
  });

  it('does not adopt a store recorded by a build that wrote a different shape', () => {
    // The version is the whole guard here. A record this build cannot read tells
    // it nothing about what is on disk, and "nothing" must not round up to "it is
    // fine".
    const older = JSON.stringify({ version: 0, ...OWNER });

    expect(decodeStoreOwner(older)).toBeUndefined();
    expect(sameStoreOwner(decodeStoreOwner(older), OWNER)).toBe(false);
  });
});
