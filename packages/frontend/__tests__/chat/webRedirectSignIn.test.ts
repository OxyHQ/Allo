import { shouldAutoSignIn, type AutoSignInPhase } from '@/lib/chat/matrixAutoSignIn';
import { authorize, pendingAuthorization } from '@/lib/chat/matrixAuthorizer.web';
import { createTabAttempt, type MatrixSignInAttempt } from '@/lib/chat/matrixSignInAttempt';
import { MatrixOidcCallbackError } from '@/lib/matrix/errors';
import { sessionPendingWebLoginStore } from '@/lib/matrix/web/oidcContext';
import { WebOidcLoginRequest, type OidcAuthorization } from '@/lib/matrix/web/oidcLogin';
import type { AlloSession } from '@/lib/matrix/types';

/**
 * A web sign-in, across the navigation that used to be a popup.
 *
 * Every other test in this change covers one piece. This one puts the pieces in
 * the order a browser puts them in — leave the page, come back to a different
 * one, finish the login that the page before it started — because that order is
 * where the two failures live that neither piece can see on its own:
 *
 * - **the loop.** An authorization server that answers without a usable code
 *   lands on a page with no memory of having tried. If it tries again, and the
 *   answer is the same, nothing stops it: the browser ping-pongs until somebody
 *   kills the tab.
 * - **the `state` check surviving.** It is the whole of what ties a callback to
 *   the request that sent it, and the request no longer exists. Rebuilding one
 *   out of storage must not become a way of accepting a `state` the app never
 *   sent.
 *
 * What is simulated here is the browser: an address bar, a navigation, and
 * storage that outlives a page load. Everything else is the shipping code.
 */

const AUTHORIZATION_ENDPOINT = 'https://auth.allo.you/authorize';
const REDIRECT_URI = 'https://allo.you/';
const HOMESERVER = 'https://matrix.allo.you';

const SESSION: AlloSession = {
  userId: '@nate:allo.you',
  deviceId: 'WEBDEVICE1',
  homeserverUrl: HOMESERVER,
  accessToken: 'access',
  refreshToken: 'refresh',
  authData: '{"version":1}',
};

/**
 * The browser: one address bar, and storage that survives a page load.
 *
 * `sessionStorage` is installed once for the whole trip, because that is exactly
 * what it is — per tab, not per page — and it is what both the login context and
 * the attempt marker rely on.
 */
class FakeBrowser {
  readonly navigations: string[] = [];
  readonly storage = new Map<string, string>();

  href: string;

  constructor(href: string) {
    this.href = href;
  }

  install(): void {
    const browser = this;
    define('location', {
      get href(): string {
        return browser.href;
      },
      assign: (url: string): void => {
        browser.navigations.push(url);
        // A real browser leaves. The next page load is a `visit()` below, which
        // is what the authorization server's redirect amounts to.
      },
    });
    define('history', {
      replaceState: (_data: unknown, _unused: string, url: string): void => {
        browser.href = url;
      },
    });
    define('sessionStorage', {
      getItem: (key: string): string | null => browser.storage.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        browser.storage.set(key, value);
      },
      removeItem: (key: string): void => {
        browser.storage.delete(key);
      },
    });
  }

  /** What the authorization server redirecting the browser back looks like. */
  visit(url: string): void {
    this.href = url;
  }
}

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

let browser: FakeBrowser;

beforeEach(() => {
  browser = new FakeBrowser(REDIRECT_URI);
  browser.install();
});

afterEach(() => {
  for (const name of ['location', 'history', 'sessionStorage']) {
    Reflect.deleteProperty(globalThis, name);
  }
});

/** The token exchange, which is the authorization server's half and not ours. */
function exchange(codes: string[]): OidcAuthorization {
  return {
    context: { deviceId: SESSION.deviceId },
    completeAuthorizationCodeGrant: async (code) => {
      codes.push(code);
      return { access_token: 'access', refresh_token: 'refresh' };
    },
  };
}

/**
 * Everything the port does when it starts a login that has to leave the page,
 * in the order `client.web.ts` does it.
 */
async function startSignIn(state: string): Promise<void> {
  const authorizationUrl = `${AUTHORIZATION_ENDPOINT}?client_id=allo&state=${state}`;
  sessionPendingWebLoginStore.write({
    state,
    authorizationUrl,
    clientId: 'allo-web',
    deviceId: SESSION.deviceId,
    codeVerifier: 'the-pkce-secret',
    redirectUri: REDIRECT_URI,
    homeserverUrl: HOMESERVER,
    authMetadata: { issuer: 'https://auth.allo.you/' },
  });
  await authorize(authorizationUrl, REDIRECT_URI);
}

/**
 * Everything the app does on the way back in, in the order the runtime does it:
 * read the response out of the URL, pick the login up, finish it.
 */
async function finishSignIn(codes: string[]): Promise<AlloSession> {
  const callbackUrl = pendingAuthorization.take();
  if (callbackUrl === undefined) {
    throw new Error('this launch carries no authorization response');
  }
  const pending = sessionPendingWebLoginStore.take();
  if (pending === undefined) {
    throw new Error('this browser has no record of the sign-in that was started');
  }
  const request = new WebOidcLoginRequest(
    exchange(codes),
    pending.authorizationUrl,
    pending.state,
    async () => SESSION,
  );
  return request.complete(callbackUrl);
}

/**
 * The gate's decision, as it is made on each page load.
 *
 * A fresh marker per load, over storage that survives them: that is a component
 * mounting in a page that has just been created by the authorization server's
 * redirect.
 */
function autoSignInOnLoad(phase: AutoSignInPhase): boolean {
  const attempt: MatrixSignInAttempt = createTabAttempt();
  const start = shouldAutoSignIn({
    phase,
    hasOxySession: true,
    alreadyAttempted: attempt.started(),
  });
  if (start) {
    attempt.record();
  }
  return start;
}

describe('a web sign-in that leaves the page', () => {
  it('finishes on the way back in', async () => {
    const codes: string[] = [];

    expect(autoSignInOnLoad('signed-out')).toBe(true);
    await startSignIn('the-state-it-sent');
    expect(browser.navigations).toEqual([
      `${AUTHORIZATION_ENDPOINT}?client_id=allo&state=the-state-it-sent`,
    ]);

    browser.visit(`${REDIRECT_URI}#code=the-code&state=the-state-it-sent`);

    await expect(finishSignIn(codes)).resolves.toEqual(SESSION);
    expect(codes).toEqual(['the-code']);
  });

  it('refuses a callback whose state it never sent', async () => {
    // The check that survives the navigation. Persisting the context is what
    // makes the login finishable at all, and it must not turn into accepting an
    // authorization from anywhere.
    const codes: string[] = [];
    await startSignIn('the-state-it-sent');

    browser.visit(`${REDIRECT_URI}#code=somebody-elses-code&state=somebody-elses-state`);

    await expect(finishSignIn(codes)).rejects.toThrow(MatrixOidcCallbackError);
    expect(codes).toEqual([]);
  });

  it('leaves nothing behind for a second page to finish', async () => {
    // The context is taken, not read: a reload after a completed login has no
    // record to complete and no code in the URL to complete it with.
    const codes: string[] = [];
    await startSignIn('the-state-it-sent');
    browser.visit(`${REDIRECT_URI}#code=the-code&state=the-state-it-sent`);
    await finishSignIn(codes);

    expect(pendingAuthorization.take()).toBeUndefined();
    expect(sessionPendingWebLoginStore.take()).toBeUndefined();
    expect(browser.href).toBe(REDIRECT_URI);
  });

  it('does not resubmit a spent code when the page is reloaded', async () => {
    // The exchange spends the code whether or not it succeeds. A reload that
    // submitted it again would be told no by the authorization server, and the
    // app would report a failed sign-in for a login that worked.
    const codes: string[] = [];
    await startSignIn('the-state-it-sent');
    browser.visit(`${REDIRECT_URI}#code=the-code&state=the-state-it-sent`);
    await finishSignIn(codes);

    await expect(finishSignIn(codes)).rejects.toThrow(/carries no authorization response/);
    expect(codes).toEqual(['the-code']);
  });
});

describe('the automatic sign-in, across page loads', () => {
  it('starts one on a launch with nothing to go on', () => {
    expect(autoSignInOnLoad('signed-out')).toBe(true);
  });

  it('does not start another when the browser comes back with nothing', async () => {
    // THE LOOP. A user pressing Back on the authorization server's page, or a
    // redirect that bounced, lands on a fresh page in exactly the state the
    // first one was in — signed out, with an Oxy session to inherit. What stops
    // it going round again is the marker, which outlives the page.
    autoSignInOnLoad('signed-out');
    await startSignIn('the-state-it-sent');
    browser.visit(REDIRECT_URI);

    expect(autoSignInOnLoad('signed-out')).toBe(false);
    expect(browser.navigations).toHaveLength(1);
  });

  it('does not start another when finishing the login failed', async () => {
    // A failure ends at the explanation and the button. `failed` is left alone by
    // the rule, and the marker is set as well, so neither of the two conditions
    // that would start one is true.
    autoSignInOnLoad('signed-out');
    await startSignIn('the-state-it-sent');
    browser.visit(`${REDIRECT_URI}#error=access_denied`);

    expect(autoSignInOnLoad('failed')).toBe(false);
    expect(autoSignInOnLoad('signed-out')).toBe(false);
    expect(browser.navigations).toHaveLength(1);
  });

  it('does not start one after a sign-out the person asked for', () => {
    // The marker is never cleared, which is what keeps a deliberate sign-out
    // from being undone by the next render. The button on the screen is how
    // somebody signs back in.
    autoSignInOnLoad('signed-out');

    expect(autoSignInOnLoad('signed-out')).toBe(false);
  });

  it('starts one in a new tab', () => {
    // `sessionStorage` is per tab. A new tab is a new run, and somebody opening
    // one is somebody trying again.
    autoSignInOnLoad('signed-out');
    browser = new FakeBrowser(REDIRECT_URI);
    browser.install();

    expect(autoSignInOnLoad('signed-out')).toBe(true);
  });
});
