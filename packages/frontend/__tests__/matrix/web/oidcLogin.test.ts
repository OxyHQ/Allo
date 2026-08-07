import { MatrixOidcCallbackError, MatrixOidcLoginSettledError } from '@/lib/matrix/errors';
import {
  WebOidcLoginRequest,
  carriesAuthorizationResponse,
  generateAuthorizationState,
  readAuthorizationResponse,
  type OidcAuthorization,
  type OidcGrant,
} from '@/lib/matrix/web/oidcLogin';
import type { AlloSession } from '@/lib/matrix/types';

/**
 * An authorization in flight, on web.
 *
 * The state machine is the native half's, for the same reasons: both terminal
 * steps are reachable twice in ordinary use — a redirect that fires more than
 * once, a user who closes the browser on an attempt the app is already finishing
 * — and letting the second one through either abandons a login that succeeded or
 * replays an authorization code the server has seen.
 *
 * What is only here is the `state` check. The native binding exchanges the code
 * itself and checks this on the way; on web the exchange is ours, so the check is
 * ours, and it is the whole of what stops a callback from somewhere else being
 * accepted as this login.
 */

const AUTHORIZATION_URL = 'https://account.allo.you/authorize?client_id=allo';
const STATE = 'e6e4b2d1c0';
const DEVICE_ID = 'WEBDEVICE1';

const SESSION: AlloSession = {
  userId: '@alice:allo.you',
  deviceId: DEVICE_ID,
  homeserverUrl: 'https://matrix.allo.you',
  accessToken: 'access',
  refreshToken: 'refresh',
  authData: '{"version":1}',
};

interface RecordingAuthorization extends OidcAuthorization {
  readonly exchanged: string[];
}

function recordingAuthorization(
  onExchange: () => Promise<void> = async () => {},
): RecordingAuthorization {
  const exchanged: string[] = [];
  return {
    exchanged,
    context: { deviceId: DEVICE_ID },
    completeAuthorizationCodeGrant: async (code) => {
      exchanged.push(code);
      await onExchange();
      return { access_token: 'access', refresh_token: 'refresh' };
    },
  };
}

function request(
  authorization: OidcAuthorization = recordingAuthorization(),
  onGrant: (grant: OidcGrant) => Promise<AlloSession> = async () => SESSION,
): WebOidcLoginRequest {
  return new WebOidcLoginRequest(authorization, AUTHORIZATION_URL, STATE, onGrant);
}

describe('readAuthorizationResponse', () => {
  it('reads the response out of the fragment, which is where it is asked for', () => {
    // The fragment keeps the authorization code out of the logs of whatever
    // serves Allo, which is why the SDK defaults to it.
    expect(readAuthorizationResponse(`https://allo.chat/callback#code=abc&state=${STATE}`)).toEqual({
      code: 'abc',
      state: STATE,
    });
  });

  it('reads a response that came back in the query instead', () => {
    expect(readAuthorizationResponse(`https://allo.chat/callback?code=abc&state=${STATE}`)).toEqual({
      code: 'abc',
      state: STATE,
    });
  });

  it('reports what the authorization server said when it said no', () => {
    expect(() =>
      readAuthorizationResponse(
        'https://allo.chat/callback#error=access_denied&error_description=User%20said%20no',
      ),
    ).toThrow('User said no');
  });

  it('refuses a callback with nothing in it', () => {
    // Not a login that half worked: a callback with no code is no login at all.
    expect(() => readAuthorizationResponse('https://allo.chat/callback')).toThrow(
      MatrixOidcCallbackError,
    );
  });

  it('refuses a callback carrying a code but no state', () => {
    expect(() => readAuthorizationResponse('https://allo.chat/callback#code=abc')).toThrow(
      MatrixOidcCallbackError,
    );
  });

  it('refuses something that is not a URL', () => {
    expect(() => readAuthorizationResponse('code=abc&state=xyz')).toThrow(MatrixOidcCallbackError);
  });
});

describe('carriesAuthorizationResponse', () => {
  /**
   * What decides whether a launch of Allo is the second half of a login that
   * left the page. On web the answer arrives as an ordinary page load, so
   * something has to tell one from the other before anything else happens.
   */

  it('recognises a response in the fragment', () => {
    expect(carriesAuthorizationResponse(`https://allo.you/#code=abc&state=${STATE}`)).toBe(true);
  });

  it('recognises a response in the query', () => {
    expect(carriesAuthorizationResponse(`https://allo.you/?code=abc&state=${STATE}`)).toBe(true);
  });

  it('recognises a refusal as a response', () => {
    // A launch carrying `error=access_denied` is a login that has to end at an
    // explanation. Calling it an ordinary launch would let the automatic sign-in
    // start another one, and another, which is the loop.
    expect(carriesAuthorizationResponse('https://allo.you/#error=access_denied')).toBe(true);
  });

  it('says no to an ordinary launch', () => {
    expect(carriesAuthorizationResponse('https://allo.you/')).toBe(false);
    expect(carriesAuthorizationResponse('https://allo.you/@nate?invite=1#/deep/link')).toBe(false);
  });

  it('says no to a state with no code, which finishes nothing', () => {
    // Half a response is not a response. Reading it would only produce a refusal
    // one step later, and this is a question about which path to take.
    expect(carriesAuthorizationResponse(`https://allo.you/#state=${STATE}`)).toBe(false);
  });

  it('says no rather than throwing at something that is not a URL', () => {
    expect(carriesAuthorizationResponse('code=abc')).toBe(false);
  });
});

describe('generateAuthorizationState', () => {
  it('is different every time', () => {
    const states = new Set(Array.from({ length: 50 }, () => generateAuthorizationState()));

    expect(states.size).toBe(50);
  });

  it('is long enough not to be guessed', () => {
    expect(generateAuthorizationState()).toHaveLength(32);
  });
});

describe('WebOidcLoginRequest', () => {
  it('hands over the URL the browser has to be sent to', () => {
    expect(request().authorizationUrl).toBe(AUTHORIZATION_URL);
  });

  it('exchanges the code and reports the session it produced', async () => {
    const authorization = recordingAuthorization();
    const grants: OidcGrant[] = [];
    const login = request(authorization, async (grant) => {
      grants.push(grant);
      return SESSION;
    });

    const session = await login.complete(`https://allo.chat/callback#code=abc&state=${STATE}`);

    expect(authorization.exchanged).toEqual(['abc']);
    expect(grants).toEqual([
      { accessToken: 'access', refreshToken: 'refresh', deviceId: DEVICE_ID },
    ]);
    expect(session).toBe(SESSION);
  });

  it('refuses a callback whose state is not the one it sent', async () => {
    // The shape a cross-site request forgery arrives in, and the shape a stale
    // redirect from an earlier attempt arrives in too.
    const authorization = recordingAuthorization();
    const login = request(authorization);

    await expect(
      login.complete('https://allo.chat/callback#code=abc&state=somebody-elses-state'),
    ).rejects.toThrow(MatrixOidcCallbackError);
    expect(authorization.exchanged).toEqual([]);
  });

  describe('once it has settled', () => {
    it('refuses a second completion', async () => {
      // A redirect that fires twice would otherwise hand the same authorization
      // code to the server again.
      const authorization = recordingAuthorization();
      const login = request(authorization);
      const callback = `https://allo.chat/callback#code=abc&state=${STATE}`;

      await login.complete(callback);

      await expect(login.complete(callback)).rejects.toThrow(MatrixOidcLoginSettledError);
      expect(authorization.exchanged).toEqual(['abc']);
    });

    it('refuses to abandon a login that already succeeded', async () => {
      const login = request();

      await login.complete(`https://allo.chat/callback#code=abc&state=${STATE}`);

      await expect(login.abort()).rejects.toThrow(MatrixOidcLoginSettledError);
    });

    it('refuses to complete a login that was abandoned', async () => {
      const authorization = recordingAuthorization();
      const login = request(authorization);

      await login.abort();

      await expect(
        login.complete(`https://allo.chat/callback#code=abc&state=${STATE}`),
      ).rejects.toThrow(MatrixOidcLoginSettledError);
      expect(authorization.exchanged).toEqual([]);
    });

    it('refuses a second abort', async () => {
      const login = request();

      await login.abort();

      await expect(login.abort()).rejects.toThrow(MatrixOidcLoginSettledError);
    });

    it('stays settled after a completion that failed', async () => {
      // The code was spent whether or not the exchange succeeded. Retrying it
      // only asks the server to accept something it has already seen, and the
      // honest recovery is a new authorization.
      const authorization = recordingAuthorization(async () => {
        throw new Error('the authorization server rejected the code');
      });
      const login = request(authorization);
      const callback = `https://allo.chat/callback#code=abc&state=${STATE}`;

      await expect(login.complete(callback)).rejects.toThrow(
        'the authorization server rejected the code',
      );

      await expect(login.complete(callback)).rejects.toThrow(MatrixOidcLoginSettledError);
      expect(authorization.exchanged).toEqual(['abc']);
    });
  });
});
