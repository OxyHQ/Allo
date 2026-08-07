import { MatrixOidcContextUnavailableError } from '@/lib/matrix/errors';
import {
  PENDING_LOGIN_KEY,
  decodePendingWebLogin,
  sessionPendingWebLoginStore,
  type PendingWebLogin,
} from '@/lib/matrix/web/oidcContext';

/**
 * What a login leaves behind when it leaves the page.
 *
 * On web the authorization is a top-level navigation, so the page holding the
 * `OAuth2` object — and with it the PKCE code verifier and the `state` that was
 * sent — is destroyed before the authorization server answers. This is where
 * those live in the meantime, and the two properties that matter are that a
 * record is used at most once and that a record which cannot be trusted is not
 * used at all.
 *
 * The test environment is React Native's and has no `sessionStorage`, so one is
 * installed here.
 */

const PENDING: PendingWebLogin = {
  state: 'e6e4b2d1c0',
  authorizationUrl: 'https://auth.allo.you/authorize?client_id=allo&state=e6e4b2d1c0',
  clientId: 'allo-web',
  deviceId: 'WEBDEVICE1',
  codeVerifier: 'a-secret-that-must-not-outlive-the-tab',
  redirectUri: 'https://allo.you/',
  homeserverUrl: 'https://matrix.allo.you',
  authMetadata: { issuer: 'https://auth.allo.you/' },
};

/** `sessionStorage`, as much of it as this module uses. */
function installStorage(): Map<string, string> {
  const entries = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: {
      getItem: (key: string): string | null => entries.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        entries.set(key, value);
      },
      removeItem: (key: string): void => {
        entries.delete(key);
      },
    },
    configurable: true,
    writable: true,
  });
  return entries;
}

beforeEach(() => {
  // A record that cannot be read says so in the log, and several of these cases
  // are exactly that. One of them asserts on it; the rest would only be noise.
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'sessionStorage');
});

describe('sessionPendingWebLoginStore', () => {
  it('hands back what was written', () => {
    installStorage();

    sessionPendingWebLoginStore.write(PENDING);

    expect(sessionPendingWebLoginStore.take()).toEqual(PENDING);
  });

  it('has nothing when nothing was written', () => {
    installStorage();

    expect(sessionPendingWebLoginStore.take()).toBeUndefined();
  });

  it('gives a login up when it hands it over', () => {
    // Taking is removing, and not as a convenience. The authorization code that
    // arrives with a record is spent by the exchange whether or not the exchange
    // works, so a record left behind can only ever produce a second attempt that
    // fails.
    const entries = installStorage();
    sessionPendingWebLoginStore.write(PENDING);

    sessionPendingWebLoginStore.take();

    expect(entries.has(PENDING_LOGIN_KEY)).toBe(false);
    expect(sessionPendingWebLoginStore.take()).toBeUndefined();
  });

  it('keeps only the most recent login', () => {
    // There cannot be two in flight on web: starting one replaces the page any
    // other was running in. One slot is the same guarantee with less to go wrong
    // than a record per `state`.
    installStorage();
    sessionPendingWebLoginStore.write(PENDING);

    sessionPendingWebLoginStore.write({ ...PENDING, state: 'a-later-attempt' });

    expect(sessionPendingWebLoginStore.take()?.state).toBe('a-later-attempt');
  });

  it('removes a record it could not read', () => {
    // Otherwise a record from an older version of Allo would be rediscovered and
    // re-refused on every launch.
    const entries = installStorage();
    entries.set(PENDING_LOGIN_KEY, 'not json');

    expect(sessionPendingWebLoginStore.take()).toBeUndefined();
    expect(entries.has(PENDING_LOGIN_KEY)).toBe(false);
    // And says so: what was discarded is somebody's sign-in.
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('discarded'));
  });

  it('refuses to start a login it cannot write down', () => {
    // Raised before the browser goes anywhere. The alternative is a person who
    // signs in on the authorization server and comes back to an app with no way
    // to finish, which looks like a sign-in that silently did nothing.
    expect(() => sessionPendingWebLoginStore.write(PENDING)).toThrow(
      MatrixOidcContextUnavailableError,
    );
  });

  it('says so rather than answering "no login" when it cannot look', () => {
    expect(() => sessionPendingWebLoginStore.take()).toThrow(MatrixOidcContextUnavailableError);
  });
});

describe('decodePendingWebLogin', () => {
  const encode = (fields: Record<string, unknown>): string =>
    JSON.stringify({ version: 1, ...PENDING, ...fields });

  it('reads back a record it wrote', () => {
    expect(decodePendingWebLogin(encode({}))).toEqual(PENDING);
  });

  it('refuses a record from another version of Allo', () => {
    // Guessing at an older shape means building a token exchange out of half a
    // context. The cost of refusing is one login.
    expect(decodePendingWebLogin(JSON.stringify({ ...PENDING, version: 0 }))).toBeUndefined();
  });

  it.each(['state', 'clientId', 'deviceId', 'codeVerifier', 'redirectUri', 'homeserverUrl'])(
    'refuses a record with no %s',
    (field) => {
      expect(decodePendingWebLogin(encode({ [field]: undefined }))).toBeUndefined();
      expect(decodePendingWebLogin(encode({ [field]: '' }))).toBeUndefined();
    },
  );

  it('refuses a record with no authorization server metadata', () => {
    expect(decodePendingWebLogin(encode({ authMetadata: undefined }))).toBeUndefined();
    expect(decodePendingWebLogin(encode({ authMetadata: 'https://auth.allo.you/' }))).toBeUndefined();
  });

  it('refuses something that is not JSON, and something that is not an object', () => {
    expect(decodePendingWebLogin('{')).toBeUndefined();
    expect(decodePendingWebLogin('"a string"')).toBeUndefined();
    expect(decodePendingWebLogin('null')).toBeUndefined();
  });
});
