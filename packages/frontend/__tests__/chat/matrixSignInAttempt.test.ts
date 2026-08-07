import {
  SIGN_IN_ATTEMPT_KEY,
  createProcessAttempt,
  createTabAttempt,
  selectSignInAttempt,
} from '@/lib/chat/matrixSignInAttempt';

/**
 * The marker that keeps "one automatic sign-in per run" true when the run spans
 * a navigation.
 *
 * On a phone a run is the process, and a variable is the whole answer. On web the
 * sign-in is a top-level redirect: the page that starts it is destroyed, and the
 * page that comes back has no memory of it. If that page decides it has never
 * tried, an authorization server that answers without a usable code — a user
 * pressing Back, a redirect that bounced — is met with another redirect, and
 * another. That is the loop these cases exist for.
 */

/** `sessionStorage`, as much of it as this module uses, shared across "reloads". */
function installStorage(entries = new Map<string, string>()): Map<string, string> {
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

afterEach(() => {
  jest.restoreAllMocks();
  Reflect.deleteProperty(globalThis, 'sessionStorage');
});

describe('createProcessAttempt', () => {
  it('has not tried until it has', () => {
    const attempt = createProcessAttempt();

    expect(attempt.started()).toBe(false);
    attempt.record();
    expect(attempt.started()).toBe(true);
  });

  it('is one run, not one component', () => {
    // Three gates mount in Allo — the conversation list, the new-conversation
    // screen and a room. A marker per component would start three sign-ins.
    const attempt = createProcessAttempt();

    attempt.record();

    expect(attempt.started()).toBe(true);
  });

  it('can be forgotten, so the run may try once more', () => {
    // One caller: `matrixRuntime` refusing a stored session because the chat data
    // on this device is not that session's. The run that recorded the attempt was
    // signing somebody else in.
    const attempt = createProcessAttempt();
    attempt.record();

    attempt.forget();

    expect(attempt.started()).toBe(false);
  });
});

describe('selectSignInAttempt', () => {
  /**
   * The branch itself, which is the part that had to change and the part a test
   * run cannot otherwise reach: jest runs one platform, and it is not web.
   */

  it('gives web a marker that survives a page load', () => {
    const entries = installStorage();
    selectSignInAttempt('web').record();

    installStorage(entries);

    expect(selectSignInAttempt('web').started()).toBe(true);
  });

  it.each(['ios', 'android'])('gives %s one that lives as long as the process', (platform) => {
    // And deliberately does not write it down. Nothing on a phone destroys the
    // app to sign in, so storage would only be a way for a marker to outlive the
    // run it belongs to.
    const entries = installStorage();
    selectSignInAttempt(platform).record();

    expect(entries.size).toBe(0);
    expect(selectSignInAttempt(platform).started()).toBe(false);
  });
});

describe('createTabAttempt', () => {
  it('has not tried until it has', () => {
    installStorage();
    const attempt = createTabAttempt();

    expect(attempt.started()).toBe(false);
    attempt.record();
    expect(attempt.started()).toBe(true);
  });

  it('remembers across the page that started it', () => {
    // The one that matters. Two `createTabAttempt()` calls over one storage are
    // two page loads of the same tab, which is exactly what a redirect to the
    // authorization server and back produces.
    const entries = installStorage();
    createTabAttempt().record();

    installStorage(entries);

    expect(createTabAttempt().started()).toBe(true);
  });

  it('is a new run in a new tab', () => {
    // `sessionStorage` is per tab, and a new tab is somebody trying again. It is
    // the reason this is not `localStorage`, along with never wanting a code
    // verifier to outlive the tab that minted it.
    installStorage();
    createTabAttempt().record();

    installStorage();

    expect(createTabAttempt().started()).toBe(false);
  });

  it('writes down that it tried, under a namespaced key', () => {
    const entries = installStorage();

    createTabAttempt().record();

    expect(entries.get(SIGN_IN_ATTEMPT_KEY)).toBe('true');
  });

  it('forgets the attempt across the page as well as within it', () => {
    // Both halves, or none. Forgetting only the variable would leave the tab's
    // record intact, and the next page load would still refuse to try — which is
    // the state this call exists to get out of.
    const entries = installStorage();
    const attempt = createTabAttempt();
    attempt.record();

    attempt.forget();

    expect(attempt.started()).toBe(false);
    expect(entries.has(SIGN_IN_ATTEMPT_KEY)).toBe(false);
    installStorage(entries);
    expect(createTabAttempt().started()).toBe(false);
  });

  it('forgets in a browser with no sessionStorage without reaching for it', () => {
    // The mirror is the only half that exists there. Reaching for the other one
    // anyway is how this would throw in a sandboxed frame.
    const attempt = createTabAttempt();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    attempt.record();

    expect(() => {
      attempt.forget();
    }).not.toThrow();
    expect(attempt.started()).toBe(false);
  });

  it('still refuses a second attempt in a browser with no sessionStorage', () => {
    // It cannot survive the navigation there, and does not pretend to — but the
    // page it is on must not start two. Nothing is lost by it: the port refuses
    // to start a redirect it cannot write the login context for, so that browser
    // ends at an explanation rather than at a loop.
    const warnings = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const attempt = createTabAttempt();

    attempt.record();

    expect(attempt.started()).toBe(true);
    expect(warnings).toHaveBeenCalledWith(expect.stringContaining('sessionStorage'));
  });
});
