/**
 * Links into Allo for other apps: start a direct conversation with someone, or
 * hand Allo something to send, and open either the way that reaches the reader.
 *
 * Free of React, React Native and of every dependency so any Oxy app (Mention,
 * a web page, a server rendering a link) can import it as
 * `@oxy.so/allo-sdk/links` without pulling the rest of the SDK into its bundle.
 * The opener takes the platform as functions (`OpenInAlloDeps`), so each app
 * binds it to its own `Linking`, browser and "get the app" prompt.
 *
 * WHERE IN ALLO.
 * - `/c/:id` takes a conversation id OR an Oxy account id: an id Allo does not
 *   know as a conversation is treated as an account, the direct conversation
 *   with that person is created (idempotent on the server) and the route is
 *   replaced with the conversation's own id
 *   (`packages/frontend/app/(chat)/c/[id]/index.tsx`). It is keyed by id rather
 *   than handle because `/c/` resolves no handles, and a handle can change under
 *   a link.
 * - `/share?text=` shows the reader's conversations and a people search, sends
 *   `text` to whichever they pick and lands them in that conversation. Sending
 *   a post means sending its permalink.
 *
 * WHICH URL. Two, and the choice between them is deliberate:
 * - `allo://…` on native. The custom scheme is the only link that reaches the
 *   installed app today: `allo.chat`, the https host Allo's Android intent
 *   filter claims, does not resolve in DNS (measured 2026-09-25), and
 *   `allo.you`, where the web app IS served, publishes no `assetlinks.json` or
 *   apple-app-site-association. An https link would therefore always open the
 *   browser, installed app or not.
 * - `https://allo.you/…` on web, and as the native fallback.
 *
 * NO `canOpenURL`. Asking first needs a `<queries>` entry on Android 11+ and
 * `LSApplicationQueriesSchemes` on iOS, and still races an install. The app
 * link is simply opened: `Linking.openURL` REJECTS when no app handles the
 * scheme, and that rejection is the "Allo is not installed" signal.
 */

/** The origin that serves Allo's web app (`packages/frontend/wrangler.toml`). */
export const ALLO_WEB_ORIGIN = 'https://allo.you';

/** Allo's custom URL scheme (`scheme` in `packages/frontend/app.config.js`). */
export const ALLO_APP_SCHEME = 'allo';

/**
 * An Oxy account id as it may appear in a path segment. Both shapes Oxy issues
 * (uuid v7, and the legacy 24-hex ObjectId) fit; anything that could escape the
 * segment (`/`, `?`, `#`, `%`, whitespace) does not, so a malformed id yields no
 * link rather than one that opens some other screen.
 */
const ACCOUNT_ID = /^[A-Za-z0-9_-]+$/;

/** One place in Allo, as both links that can reach it. */
export interface AlloLinks {
  /** Opens the installed app straight there. */
  app: string;
  /** The same place in Allo's web app. */
  web: string;
}

function linksTo(pathAndQuery: string): AlloLinks {
  return {
    app: `${ALLO_APP_SCHEME}://${pathAndQuery}`,
    web: `${ALLO_WEB_ORIGIN}/${pathAndQuery}`,
  };
}

/**
 * The links that open a direct conversation with `oxyUserId`, or `null` when
 * the id cannot address one.
 */
export function alloDirectMessageLinks(oxyUserId: string | null | undefined): AlloLinks | null {
  if (typeof oxyUserId !== 'string') return null;
  const id = oxyUserId.trim();
  return ACCOUNT_ID.test(id) ? linksTo(`c/${id}`) : null;
}

/** The links that open Allo's share picker with `text` to send, or `null` for no text. */
export function alloShareLinks(text: string | null | undefined): AlloLinks | null {
  const message = typeof text === 'string' ? text.trim() : '';
  return message ? linksTo(`share?text=${encodeURIComponent(message)}`) : null;
}

/** Where an app lists Allo, per platform. */
export interface AlloStoreListings {
  ios: string | undefined;
  android: string | undefined;
}

/**
 * The store listing for `platformOS`, or `undefined` where there is none. Only
 * an https URL is accepted, so a misconfigured value cannot become a scheme the
 * OS hands to something else.
 */
export function alloStoreUrl(platformOS: string, listings: AlloStoreListings): string | undefined {
  const candidate =
    platformOS === 'ios' ? listings.ios : platformOS === 'android' ? listings.android : undefined;
  const url = candidate?.trim();
  return url?.startsWith('https://') ? url : undefined;
}

/** What `openInAllo` did, for the caller and the tests. */
export type AlloOpenOutcome =
  /** There was nowhere to open (no links); nothing was opened. */
  | 'invalid'
  /** Web: Allo's web app opened. */
  | 'web'
  /** Native: the installed app took the link. */
  | 'app'
  /** Native, no app: the reader was offered the store or the web app. */
  | 'offered'
  /** Native, no app and no store listing: Allo's web app opened in the browser. */
  | 'browser';

export interface OpenInAlloDeps {
  /** `Platform.OS`, or `'web'`. */
  platformOS: string;
  /** Hands a URL to the OS; rejects when nothing handles it (`Linking.openURL`). */
  openAppUrl: (url: string) => Promise<unknown>;
  /** Opens an https URL in the browser. */
  openWebUrl: (url: string) => Promise<unknown>;
  /** From `alloStoreUrl`; the install offer is made only when present. */
  storeUrl?: string;
  /** Presents "Get Allo" / "Open Allo on the web" to the reader. */
  offerInstall: (choice: { storeUrl: string; webUrl: string }) => void;
}

/**
 * Open `links`: the web app on web; on native, the installed app, or — when it
 * is not installed — an offer to get it or to continue on the web, or the web
 * app itself when there is nothing to install from.
 */
export async function openInAllo(
  links: AlloLinks | null,
  deps: OpenInAlloDeps,
): Promise<AlloOpenOutcome> {
  if (links === null) return 'invalid';

  if (deps.platformOS === 'web') {
    await deps.openWebUrl(links.web);
    return 'web';
  }

  try {
    await deps.openAppUrl(links.app);
    return 'app';
  } catch {
    // No app handles `allo://` — Allo is not installed. Fall through.
  }

  if (deps.storeUrl) {
    deps.offerInstall({ storeUrl: deps.storeUrl, webUrl: links.web });
    return 'offered';
  }

  await deps.openWebUrl(links.web);
  return 'browser';
}
