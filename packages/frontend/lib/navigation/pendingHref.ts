/**
 * WHERE A SIGNED-OUT VISITOR WAS GOING.
 *
 * Signed out, `app/_layout.tsx` redirects the whole `(chat)` group to the
 * welcome screen, so `allo://c/<id>` or `https://allo.you/c/<id>` lands on
 * sign-in and, after it, on the chat list: the conversation the link named is
 * gone (OxyHQ/Allo#176). This module holds that destination across the sign-in
 * and hands it back exactly once; `usePendingHref` records and replays it.
 *
 * On web it is also written to `sessionStorage`, because Oxy's sign-in may fall
 * back from a popup to a full-page redirect, and a reload would drop a value
 * held only in memory. Nothing else is persisted, and a failure to persist only
 * costs the web-redirect case.
 */

const STORAGE_KEY = 'allo.pending_href';

/** Query parameters that mark an OAuth callback rather than a destination. */
const OAUTH_PARAMS = ['code', 'state', 'error'];

/** `exp://host:port/--/path` — Expo Go and dev-client URLs put the route after `/--/`. */
const EXPO_DEV_SEPARATOR = '/--/';

/**
 * The in-app href a URL names, or `null` when it names none worth restoring.
 *
 * Accepts the three shapes that reach the app: `https://allo.you/c/x`,
 * `allo://c/x` (the scheme's "host" is the first path segment, which is how
 * expo-router reads it) and `exp://…/--/c/x`. Only the path and the query are
 * kept, so the result can only ever navigate inside the app. The root is `null`:
 * it is where signing in goes anyway, and it is what an OAuth callback lands on.
 */
export function hrefFromUrl(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url.length === 0) return null;

  let pathAndQuery: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (url.startsWith('/')) {
    pathAndQuery = url;
  } else if (!scheme) {
    return null;
  } else if (url.includes(EXPO_DEV_SEPARATOR)) {
    pathAndQuery = `/${url.slice(url.indexOf(EXPO_DEV_SEPARATOR) + EXPO_DEV_SEPARATOR.length)}`;
  } else if (/^https?$/i.test(scheme[1])) {
    try {
      const parsed = new URL(url);
      pathAndQuery = `${parsed.pathname}${parsed.search}`;
    } catch {
      return null;
    }
  } else if (/^exps?$/i.test(scheme[1])) {
    // A dev-server URL with no route after it: the app's root.
    return null;
  } else {
    // `allo://c/x` and `allo:///c/x` both name `/c/x`.
    pathAndQuery = `/${url.slice(scheme[0].length).replace(/^\/+/, '')}`;
  }

  // The fragment never names a route.
  pathAndQuery = pathAndQuery.split('#')[0];
  const queryAt = pathAndQuery.indexOf('?');
  const pathname = (queryAt === -1 ? pathAndQuery : pathAndQuery.slice(0, queryAt)).replace(/\/+$/, '');
  const search = queryAt === -1 ? '' : pathAndQuery.slice(queryAt);

  // `//host` would be read as another origin by anything that resolves it.
  if (pathname === '' || pathname.startsWith('//')) return null;

  const params = new URLSearchParams(search);
  if (OAUTH_PARAMS.some((name) => params.has(name))) return null;

  return `${pathname}${search}`;
}

let pending: string | null = null;

function sessionStore(): Storage | null {
  try {
    const store = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    return store ?? null;
  } catch {
    return null;
  }
}

/** Remember where the visitor was going. A later destination replaces an earlier one. */
export function rememberPendingHref(href: string | null): void {
  if (href === null) return;
  pending = href;
  try {
    sessionStore()?.setItem(STORAGE_KEY, href);
  } catch {
    // Storage refused (private mode, quota): the in-memory value still covers a popup sign-in.
  }
}

/** The remembered destination, once: reading it forgets it. */
export function takePendingHref(): string | null {
  let href = pending;
  pending = null;
  try {
    const store = sessionStore();
    const stored = store?.getItem(STORAGE_KEY) ?? null;
    store?.removeItem(STORAGE_KEY);
    href = href ?? hrefFromUrl(stored);
  } catch {
    // Nothing stored, or storage unavailable.
  }
  return href;
}
