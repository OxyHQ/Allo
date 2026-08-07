import type {
  AuthorizationOutcome,
  MatrixAuthorizer,
  MatrixPendingAuthorization,
} from '@/lib/chat/matrixAuthorization';
import { carriesAuthorizationResponse } from '@/lib/matrix/web/oidcLogin';
import { logger } from '@/utils/logger';

/**
 * The authorization step in a browser: a top-level redirect, and no popup.
 *
 * `expo-web-browser`'s `openAuthSessionAsync` is `window.open` on web, and a
 * popup with no user gesture behind it is blocked. Allo's Matrix sign-in starts
 * on its own — the person is already signed in to Oxy and being asked to sign in
 * again is exactly what that removes — so there is no gesture to have, and the
 * popup was blocked every time. Nobody could sign in on web at all.
 *
 * A top-level navigation needs no gesture, is the flow OpenID Connect is
 * specified around, and is what `matrix-js-sdk`'s `OAuth2` is built for: its
 * context is documented as "the persistent context needed for typical OAuth
 * flows" precisely because the typical flow destroys the page holding it.
 *
 * It also retires the reason the redirect used to point at a static file rather
 * than at the app. That reason was the popup — a redirect into an app route
 * would have booted a second copy of Allo *inside the popup*, and two
 * `MatrixClient`s on one IndexedDB corrupt the crypto store. A top-level
 * redirect replaces the page instead of adding one, so there is only ever one
 * copy of Allo, and the app can be its own redirect target.
 *
 * **What it costs:** the browser comes back to the redirect URI, which is the
 * app's root, and not to the screen the person was on. A sign-in happens once
 * per browser and lands on the conversation list, which is where somebody
 * signing in to a messaging app is going anyway; restoring the exact screen
 * would mean carrying a path across the authorization server and re-entering it
 * through the router, which is a redirect of our own to get wrong.
 */

/**
 * The parameters an authorization server may add to the redirect URI, all of
 * which belong to this login and to nothing else on the page.
 *
 * `iss` and `session_state` are not read by anything here; they are listed
 * because leaving them in the address bar would leave a URL that looks like an
 * unfinished callback to the next person who reads it or copies it.
 */
const RESPONSE_PARAMETERS = [
  'code',
  'state',
  'error',
  'error_description',
  'error_uri',
  'iss',
  'session_state',
] as const;

export const authorize: MatrixAuthorizer = async (
  authorizationUrl,
): Promise<AuthorizationOutcome> => {
  // Annotated rather than inferred, the same way `matrixSessionStorage.ts` reads
  // `localStorage`: the DOM types declare it as always present, and the point of
  // the check is the runtime where it is not.
  const location: Location | undefined = globalThis.location;
  if (location === undefined) {
    throw new Error(
      'Allo cannot send this browser to the sign-in page, because there is no ' +
        'window to send. A Matrix sign-in cannot be started while the app is ' +
        'being rendered on a server.',
    );
  }

  // Everything the login needs to survive this has already been written down by
  // the port (`lib/matrix/web/oidcContext.ts`); the page itself is not coming
  // back. Navigation is asynchronous, so this call returns and the runtime gets
  // to publish the phase that says so before the browser leaves.
  location.assign(authorizationUrl);
  return { kind: 'left' };
};

export const pendingAuthorization: MatrixPendingAuthorization = {
  take: () => {
    const location: Location | undefined = globalThis.location;
    if (location === undefined) {
      return undefined;
    }
    const href = location.href;
    if (!carriesAuthorizationResponse(href)) {
      return undefined;
    }
    // The response is removed from the address bar and kept in hand: `href` is a
    // string and the rewrite below cannot reach it. That is the whole of "take"
    // — the caller has the only copy left, and there is nothing for a reload to
    // find.
    stripAuthorizationResponse(href);
    return href;
  },
};

/**
 * Removes the authorization response from the address bar, in place.
 *
 * A reload must not resubmit a spent authorization code, and the URL is also the
 * one thing a user might copy or a browser might keep in history — an
 * authorization code has no business in either.
 *
 * Anything else in the query or the fragment is left exactly as it was, byte for
 * byte: a fragment that carries none of these parameters is not rewritten at
 * all, because re-serialising an arbitrary fragment through `URLSearchParams`
 * would mangle one that was never a query string to begin with.
 */
function stripAuthorizationResponse(href: string): void {
  const history: History | undefined = globalThis.history;
  if (typeof history?.replaceState !== 'function') {
    // Nothing to do about it, and not worth refusing the sign-in over: the
    // login still completes. What is left behind is a spent code in the address
    // bar, which the next attempt refuses rather than replays.
    logger.warn(
      '[chat] the sign-in response was left in the address bar: this browser has no ' +
        'history.replaceState',
    );
    return;
  }

  const url = new URL(href);
  const fragment = withoutResponse(new URLSearchParams(url.hash.replace(/^#/, '')));
  const query = withoutResponse(url.searchParams);
  if (fragment === undefined && query === undefined) {
    return;
  }
  if (fragment !== undefined) {
    const remaining = fragment.toString();
    url.hash = remaining === '' ? '' : `#${remaining}`;
  }
  if (query !== undefined) {
    url.search = query.toString();
  }
  history.replaceState(null, '', url.toString());
}

/**
 * The same parameters without the authorization response, or `undefined` if
 * there was none in them and they should be left untouched.
 */
function withoutResponse(parameters: URLSearchParams): URLSearchParams | undefined {
  const remaining = new URLSearchParams(parameters);
  let found = false;
  for (const name of RESPONSE_PARAMETERS) {
    if (remaining.has(name)) {
      remaining.delete(name);
      found = true;
    }
  }
  return found ? remaining : undefined;
}
