import { authorize, pendingAuthorization } from '@/lib/chat/matrixAuthorizer.web';

/**
 * The web half of OIDC's middle step: a top-level redirect out, and a URL to
 * read on the way back in.
 *
 * What it replaced was `WebBrowser.openAuthSessionAsync`, which on web is
 * `window.open`. Allo starts this sign-in without being asked — there is an Oxy
 * session to inherit — so there is no user gesture behind it and the popup was
 * blocked every time. These cases are about the two halves of the replacement:
 * that leaving says so rather than pretending to wait, and that coming back is
 * read once and only once.
 *
 * The test environment is React Native's, which has a `window` but no `location`,
 * `history` or `sessionStorage`. They are installed here rather than mocked
 * through a module boundary, because what is being checked is this module's use
 * of the real browser API and a mock of the browser would be a mock of the thing
 * under test.
 */

const AUTHORIZATION_URL = 'https://auth.allo.you/authorize?client_id=allo&state=xyz';

/** The address bar, as much of it as this module touches. */
interface FakeBrowser {
  /** Every URL the top-level window was sent to, in order. */
  readonly navigations: string[];
  /** Where the address bar points now. */
  href(): string;
}

/**
 * Installs a browser at a URL, and hands back a way to watch it.
 *
 * `history.replaceState` moves `location.href`, which is what a real browser
 * does and what the "a reload does not resubmit a spent code" case rests on.
 */
function browserAt(initial: string): FakeBrowser {
  const navigations: string[] = [];
  let href = initial;
  define('location', {
    get href(): string {
      return href;
    },
    assign: (url: string): void => {
      navigations.push(url);
    },
  });
  define('history', {
    replaceState: (_data: unknown, _unused: string, url: string): void => {
      href = url;
    },
  });
  return { navigations, href: () => href };
}

function define(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function remove(name: string): void {
  Reflect.deleteProperty(globalThis, name);
}

afterEach(() => {
  remove('location');
  remove('history');
});

describe('authorize', () => {
  it('sends the top-level window to the authorization server', async () => {
    // No popup, so no popup blocker. This is the whole fix.
    const browser = browserAt('https://allo.you/');

    const outcome = await authorize(AUTHORIZATION_URL, 'https://allo.you/');

    expect(browser.navigations).toEqual([AUTHORIZATION_URL]);
    expect(outcome).toEqual({ kind: 'left' });
  });

  it('hands the URL over untouched', async () => {
    // It carries the PKCE challenge and the `state` the callback is checked
    // against. Anything added or dropped here is a login that cannot be finished.
    const browser = browserAt('https://allo.you/');

    await authorize(AUTHORIZATION_URL, 'https://allo.you/');

    expect(browser.navigations[0]).toBe(AUTHORIZATION_URL);
  });

  it('refuses to pretend it navigated when there is no window', async () => {
    remove('location');

    await expect(authorize(AUTHORIZATION_URL, 'https://allo.you/')).rejects.toThrow(
      /no window to send/,
    );
  });
});

describe('pendingAuthorization', () => {
  it('has nothing to say about an ordinary launch', () => {
    browserAt('https://allo.you/');

    expect(pendingAuthorization.take()).toBeUndefined();
  });

  it('reads a response out of the fragment, which is where it is asked for', () => {
    browserAt('https://allo.you/#code=abc&state=xyz');

    expect(pendingAuthorization.take()).toBe('https://allo.you/#code=abc&state=xyz');
  });

  it('reads a response that came back in the query instead', () => {
    // The request asks for `fragment`, but an authorization server is free to
    // answer in the query and a response that arrives is better read than
    // dropped.
    browserAt('https://allo.you/?code=abc&state=xyz');

    expect(pendingAuthorization.take()).toBe('https://allo.you/?code=abc&state=xyz');
  });

  it('reads a refusal as a response too', () => {
    // A launch carrying `error=access_denied` is the second half of a login and
    // has to be finished — as a failure, with an explanation. Treating it as an
    // ordinary launch would let the automatic sign-in start another one, and
    // that is the loop.
    browserAt('https://allo.you/#error=access_denied&error_description=no');

    expect(pendingAuthorization.take()).toBe(
      'https://allo.you/#error=access_denied&error_description=no',
    );
  });

  it('takes the response out of the address bar', () => {
    const browser = browserAt('https://allo.you/#code=abc&state=xyz');

    pendingAuthorization.take();

    expect(browser.href()).toBe('https://allo.you/');
  });

  it('does not offer a spent code to a reload', () => {
    // The case this is for: the exchange spends the code whether or not it
    // succeeds, so a second read of the same URL can only ever fail — and would
    // report a failed sign-in for a code that worked the first time.
    browserAt('https://allo.you/#code=abc&state=xyz');

    const first = pendingAuthorization.take();
    const second = pendingAuthorization.take();

    expect(first).toBe('https://allo.you/#code=abc&state=xyz');
    expect(second).toBeUndefined();
  });

  it('takes the response out of the query as well', () => {
    const browser = browserAt('https://allo.you/?code=abc&state=xyz');

    pendingAuthorization.take();

    expect(browser.href()).toBe('https://allo.you/');
  });

  it('leaves everything else in the URL exactly as it was', () => {
    const browser = browserAt('https://allo.you/?invite=nate#code=abc&state=xyz&keep=me');

    pendingAuthorization.take();

    expect(browser.href()).toBe('https://allo.you/?invite=nate#keep=me');
  });

  it('does not rewrite a fragment that is not a response', () => {
    // A fragment is not always a query string. Re-serialising `#/some/route`
    // through URLSearchParams would mangle it into `%2Fsome%2Froute=`.
    const browser = browserAt('https://allo.you/?code=abc&state=xyz#/some/route');

    pendingAuthorization.take();

    expect(browser.href()).toBe('https://allo.you/#/some/route');
  });

  it('finishes the login even when the address bar cannot be rewritten', () => {
    // A browser with no `history.replaceState`. The code still works; what is
    // left behind is a spent one in the URL, which the next attempt refuses
    // rather than replays. It is said out loud, because it is the one case where
    // what stays in the address bar is not what this module intended.
    browserAt('https://allo.you/#code=abc&state=xyz');
    remove('history');
    const warnings = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(pendingAuthorization.take()).toBe('https://allo.you/#code=abc&state=xyz');
      expect(warnings).toHaveBeenCalledWith(
        expect.stringContaining('left in the address bar'),
      );
    } finally {
      warnings.mockRestore();
    }
  });

  it('has nothing to say where there is no window at all', () => {
    // Prerendering. There is no browser to have come back from anywhere.
    remove('location');

    expect(pendingAuthorization.take()).toBeUndefined();
  });
});
