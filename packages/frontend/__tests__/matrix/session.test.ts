import { toAlloSession } from '@/lib/matrix/native/session';

/**
 * The session translation, and the one piece of the native implementation that
 * needs nothing of the binding at runtime.
 *
 * That is why there is no `jest.mock` here and why this file, unlike the four
 * beside it, runs under any test runner: the authentication path depends only on
 * this and on the port's own types, so proving it does not require loading a
 * native module that a test process cannot load.
 */

describe('toAlloSession', () => {
  it('carries the SDK’s OIDC blob through as the port’s opaque auth data', () => {
    // Under MAS this is not optional detail: it holds what the SDK refreshes the
    // tokens with, so a session stored without it restores into a client that
    // cannot renew itself and stops working when the access token expires.
    expect(
      toAlloSession({
        userId: '@alice:allo.oxy.so',
        deviceId: 'DEVICE1',
        homeserverUrl: 'https://matrix.allo.oxy.so',
        accessToken: 'access',
        refreshToken: 'refresh',
        oidcData: '{"issuer":"https://account.allo.oxy.so/"}',
      }),
    ).toEqual({
      userId: '@alice:allo.oxy.so',
      deviceId: 'DEVICE1',
      homeserverUrl: 'https://matrix.allo.oxy.so',
      accessToken: 'access',
      refreshToken: 'refresh',
      authData: '{"issuer":"https://account.allo.oxy.so/"}',
    });
  });

  it('keeps the optional credentials absent rather than inventing them', () => {
    const session = toAlloSession({
      userId: '@alice:allo.oxy.so',
      deviceId: 'DEVICE1',
      homeserverUrl: 'https://matrix.allo.oxy.so',
      accessToken: 'access',
      refreshToken: undefined,
      oidcData: undefined,
    });

    expect(session.refreshToken).toBeUndefined();
    expect(session.authData).toBeUndefined();
  });
});

