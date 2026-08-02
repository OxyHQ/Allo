import { MatrixSessionRestoreError } from '@/lib/matrix/errors';
import { decodeAuthData, encodeAuthData } from '@/lib/matrix/web/session';

/**
 * The opaque half of a persisted session.
 *
 * `AlloSession.authData` is written by one implementation and read back by the
 * same one, and on web it is what makes a restored session able to refresh its
 * own tokens. Every case here is a refusal, because the alternative to refusing
 * is a client that believes it can renew a token and cannot.
 */

const AUTH_METADATA = {
  issuer: 'https://account.allo.you/',
  token_endpoint: 'https://account.allo.you/oauth2/token',
};

const AUTH_DATA = {
  clientId: 'https://allo.chat/oauth-client',
  redirectUri: 'https://allo.chat/oidc-callback',
  authMetadata: AUTH_METADATA,
};

describe('web session auth data', () => {
  it('reads back exactly what it wrote', () => {
    expect(decodeAuthData(encodeAuthData(AUTH_DATA))).toEqual({ version: 1, ...AUTH_DATA });
  });

  it('refuses a session that carries none', () => {
    // Which is what a session written by the native client looks like from here.
    expect(() => decodeAuthData(undefined)).toThrow(MatrixSessionRestoreError);
  });

  it('refuses data that is not JSON', () => {
    expect(() => decodeAuthData('not json')).toThrow(MatrixSessionRestoreError);
  });

  it('refuses data that is JSON but not an object', () => {
    expect(() => decodeAuthData('"a string"')).toThrow(MatrixSessionRestoreError);
    expect(() => decodeAuthData('null')).toThrow(MatrixSessionRestoreError);
  });

  it('refuses a version it does not know', () => {
    // An older payload is refused rather than guessed at: the cost is one login.
    const older = JSON.stringify({ ...AUTH_DATA, version: 0 });

    expect(() => decodeAuthData(older)).toThrow(MatrixSessionRestoreError);
  });

  it('refuses data missing anything a token refresh needs', () => {
    const withoutField = (field: keyof typeof AUTH_DATA): string => {
      const fields: Record<string, unknown> = { version: 1, ...AUTH_DATA };
      delete fields[field];
      return JSON.stringify(fields);
    };

    expect(() => decodeAuthData(withoutField('clientId'))).toThrow(MatrixSessionRestoreError);
    expect(() => decodeAuthData(withoutField('redirectUri'))).toThrow(MatrixSessionRestoreError);
    expect(() => decodeAuthData(withoutField('authMetadata'))).toThrow(MatrixSessionRestoreError);
  });

  it('refuses an empty client id rather than registering as nobody', () => {
    const empty = JSON.stringify({ version: 1, ...AUTH_DATA, clientId: '' });

    expect(() => decodeAuthData(empty)).toThrow(MatrixSessionRestoreError);
  });
});
