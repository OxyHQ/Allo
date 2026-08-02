import type { OAuthAuthorizationDataLike } from '@unomed/react-native-matrix-sdk';

import { MatrixOidcLoginSettledError } from '@/lib/matrix/errors';
import {
  NativeOidcLoginRequest,
  type OidcLoginClient,
} from '@/lib/matrix/native/oidcLogin';
import type { SessionFields } from '@/lib/matrix/native/session';

/**
 * An authorization in flight.
 *
 * The state machine is small and the reason it exists is not obvious, so it is
 * worth pinning: both terminal steps are reachable twice in ordinary use — a
 * redirect that fires more than once, a user who closes the browser on an attempt
 * the app is already finishing — and letting the second one through either aborts
 * a login that succeeded or replays an authorization code the server has seen.
 */

const AUTHORIZATION_URL = 'https://account.allo.you/authorize?client_id=allo';
const CALLBACK_URL = 'allo://oidc-callback?code=abc&state=xyz';

const SESSION: SessionFields = {
  userId: '@alice:allo.you',
  deviceId: 'DEVICE1',
  homeserverUrl: 'https://matrix.allo.you',
  accessToken: 'access',
  refreshToken: 'refresh',
  oidcData: '{"issuer":"https://account.allo.you/"}',
};

function authorizationData(): OAuthAuthorizationDataLike {
  return { loginUrl: () => AUTHORIZATION_URL };
}

interface RecordingClient extends OidcLoginClient {
  readonly completed: string[];
  readonly aborted: OAuthAuthorizationDataLike[];
}

function recordingClient(
  onCallback: () => Promise<void> = async () => {},
): RecordingClient {
  const completed: string[] = [];
  const aborted: OAuthAuthorizationDataLike[] = [];
  return {
    completed,
    aborted,
    loginWithOidcCallback: async (callbackUrl) => {
      completed.push(callbackUrl);
      await onCallback();
    },
    abortOidcAuth: async (data) => {
      aborted.push(data);
    },
    session: () => SESSION,
  };
}

describe('NativeOidcLoginRequest', () => {
  it('hands over the URL the browser has to be sent to', () => {
    const request = new NativeOidcLoginRequest(recordingClient(), authorizationData());

    expect(request.authorizationUrl).toBe(AUTHORIZATION_URL);
  });

  it('finishes with the URL the browser came back to, and reports the session', async () => {
    const client = recordingClient();
    const request = new NativeOidcLoginRequest(client, authorizationData());

    const session = await request.complete(CALLBACK_URL);

    expect(client.completed).toEqual([CALLBACK_URL]);
    expect(session).toEqual({
      userId: '@alice:allo.you',
      deviceId: 'DEVICE1',
      homeserverUrl: 'https://matrix.allo.you',
      accessToken: 'access',
      refreshToken: 'refresh',
      authData: '{"issuer":"https://account.allo.you/"}',
    });
  });

  it('abandons the very authorization it was given', async () => {
    // The SDK keys the server-side state of the attempt on this object, so the
    // one handed back has to be the one that was handed in.
    const client = recordingClient();
    const data = authorizationData();
    const request = new NativeOidcLoginRequest(client, data);

    await request.abort();

    expect(client.aborted).toEqual([data]);
  });

  it('does not abort an authorization that was only completed', async () => {
    const client = recordingClient();
    const request = new NativeOidcLoginRequest(client, authorizationData());

    await request.complete(CALLBACK_URL);

    expect(client.aborted).toEqual([]);
  });

  describe('once it has settled', () => {
    it('refuses a second completion', async () => {
      // A redirect that fires twice would otherwise hand the same authorization
      // code to the server again.
      const client = recordingClient();
      const request = new NativeOidcLoginRequest(client, authorizationData());

      await request.complete(CALLBACK_URL);

      await expect(request.complete(CALLBACK_URL)).rejects.toThrow(
        MatrixOidcLoginSettledError,
      );
      expect(client.completed).toEqual([CALLBACK_URL]);
    });

    it('refuses to abort a login that already succeeded', async () => {
      const client = recordingClient();
      const request = new NativeOidcLoginRequest(client, authorizationData());

      await request.complete(CALLBACK_URL);

      await expect(request.abort()).rejects.toThrow(MatrixOidcLoginSettledError);
      expect(client.aborted).toEqual([]);
    });

    it('refuses to complete a login that was abandoned', async () => {
      const client = recordingClient();
      const request = new NativeOidcLoginRequest(client, authorizationData());

      await request.abort();

      await expect(request.complete(CALLBACK_URL)).rejects.toThrow(
        MatrixOidcLoginSettledError,
      );
      expect(client.completed).toEqual([]);
    });

    it('refuses a second abort', async () => {
      const client = recordingClient();
      const request = new NativeOidcLoginRequest(client, authorizationData());

      await request.abort();

      await expect(request.abort()).rejects.toThrow(MatrixOidcLoginSettledError);
      expect(client.aborted).toHaveLength(1);
    });

    it('stays settled after a completion that failed', async () => {
      // The code was spent whether or not the call succeeded. Retrying it only
      // asks the server to accept something it has already seen, and the honest
      // recovery is a new authorization.
      const client = recordingClient(async () => {
        throw new Error('the homeserver rejected the code');
      });
      const request = new NativeOidcLoginRequest(client, authorizationData());

      await expect(request.complete(CALLBACK_URL)).rejects.toThrow(
        'the homeserver rejected the code',
      );

      await expect(request.complete(CALLBACK_URL)).rejects.toThrow(
        MatrixOidcLoginSettledError,
      );
      expect(client.completed).toEqual([CALLBACK_URL]);
    });
  });
});
