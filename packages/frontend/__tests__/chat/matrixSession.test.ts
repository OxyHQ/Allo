import {
  STORED_SESSION_VERSION,
  decodeStoredSession,
  encodeStoredSession,
} from '@/lib/chat/matrixSession';
import type { AlloSession } from '@/lib/matrix/types';

/**
 * The session as it is written down between launches.
 *
 * Every case here is a way of reading back something a *different* Allo wrote —
 * an older version, a build pointed at another homeserver, storage that answered
 * with something truncated. The rule they all check is the same: a record that
 * cannot be used in full is refused, never repaired. A half-valid session is not
 * a session that half works; it is one the SDK accepts and then cannot renew, and
 * the user meets that as messages that stop arriving rather than as a sign-in
 * screen.
 */

const HOMESERVER = 'https://matrix.allo.you';

const SESSION: AlloSession = {
  userId: '@alice:allo.you',
  deviceId: 'DEVICE1',
  homeserverUrl: HOMESERVER,
  // Distinctive on purpose: one of the cases below checks that no reason a
  // record is refused for ever quotes one of them.
  accessToken: 'secret-access-token',
  refreshToken: 'secret-refresh-token',
  authData: '{"issuer":"https://account.allo.you/"}',
};

/** A stored record with one field replaced, as JSON. */
function record(session: Record<string, unknown>, version: unknown = STORED_SESSION_VERSION): string {
  return JSON.stringify({ version, session });
}

describe('encodeStoredSession and decodeStoredSession', () => {
  it('round-trips a session unchanged', () => {
    const outcome = decodeStoredSession(encodeStoredSession(SESSION), HOMESERVER);

    expect(outcome).toEqual({ kind: 'session', session: SESSION });
  });

  it('round-trips a session with no refresh token and no auth data', () => {
    // A homeserver that issues no refresh token is a homeserver, not a damaged
    // record. `JSON.stringify` drops the keys entirely, so this is also the check
    // that reading an absent optional back is not a refusal.
    const minimal: AlloSession = {
      ...SESSION,
      refreshToken: undefined,
      authData: undefined,
    };

    expect(decodeStoredSession(encodeStoredSession(minimal), HOMESERVER)).toEqual({
      kind: 'session',
      session: minimal,
    });
  });

  it('reports nothing stored as absent rather than as a problem', () => {
    // The ordinary state of a fresh install, and the one case that must not be
    // logged as a session being abandoned.
    expect(decodeStoredSession(undefined, HOMESERVER)).toEqual({ kind: 'absent' });
    expect(decodeStoredSession('', HOMESERVER)).toEqual({ kind: 'absent' });
  });
});

describe('decodeStoredSession refusals', () => {
  /** The reason a record was refused, or a failure if it was not refused. */
  function refusal(raw: string, homeserverUrl = HOMESERVER): string {
    const outcome = decodeStoredSession(raw, homeserverUrl);
    if (outcome.kind !== 'unusable') {
      throw new Error(`expected a refusal, got ${outcome.kind}`);
    }
    return outcome.reason;
  }

  it('refuses something that is not JSON', () => {
    expect(refusal('not json at all')).toContain('not JSON');
  });

  it('refuses JSON that is not an object', () => {
    expect(refusal('"a string"')).toContain('not an object');
    expect(refusal('null')).toContain('not an object');
  });

  it('refuses a version it did not write', () => {
    // Guessing at an older shape ends in a client that believes it has a session
    // and cannot refresh it. The cost of refusing is one sign-in.
    expect(refusal(record({ ...SESSION }, STORED_SESSION_VERSION + 1))).toContain(
      String(STORED_SESSION_VERSION + 1),
    );
    // Written by something that carried no version at all.
    expect(refusal(JSON.stringify({ session: SESSION }))).toContain('version');
  });

  it('refuses a record with no session in it', () => {
    expect(refusal(JSON.stringify({ version: STORED_SESSION_VERSION }))).toContain(
      'no session',
    );
  });

  it('names the field that is missing', () => {
    expect(refusal(record({ ...SESSION, userId: undefined }))).toContain('no user');
    expect(refusal(record({ ...SESSION, deviceId: undefined }))).toContain('no device');
    expect(refusal(record({ ...SESSION, homeserverUrl: undefined }))).toContain(
      'no homeserver',
    );
    expect(refusal(record({ ...SESSION, accessToken: undefined }))).toContain(
      'no access token',
    );
  });

  it('treats an empty string as a missing field', () => {
    // An empty device id is not a device. It would restore into a client whose
    // encryption keys hang off nothing.
    expect(refusal(record({ ...SESSION, deviceId: '' }))).toContain('no device');
  });

  it('refuses an optional field that is not a string', () => {
    // Absent is a homeserver that issues no refresh token; a number is a damaged
    // record, and the two must not be confused.
    expect(refusal(record({ ...SESSION, refreshToken: 42 }))).toContain('refresh token');
    expect(refusal(record({ ...SESSION, authData: { issuer: 'x' } }))).toContain(
      'authentication data',
    );
  });

  it('refuses a session issued by another homeserver, and names both', () => {
    // A build repointed elsewhere. The device id in this session was never issued
    // by the homeserver this build talks to.
    const reason = refusal(encodeStoredSession(SESSION), 'https://elsewhere.example');

    expect(reason).toContain(HOMESERVER);
    expect(reason).toContain('https://elsewhere.example');
  });

  it('never quotes a credential in the reason it gives', () => {
    // Reasons are logged. The tokens in a session are not.
    const reasons = [
      refusal(record({ ...SESSION, userId: undefined })),
      refusal(record({ ...SESSION, refreshToken: 42 })),
      refusal(encodeStoredSession(SESSION), 'https://elsewhere.example'),
    ];

    for (const reason of reasons) {
      expect(reason).not.toContain('secret-');
      expect(reason).not.toContain('account.allo.you');
    }
  });
});
