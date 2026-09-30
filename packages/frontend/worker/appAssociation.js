/**
 * The two documents that let the native apps own `https://allo.you/...` links:
 * Android App Links (`/.well-known/assetlinks.json`) and iOS Universal Links
 * (`/.well-known/apple-app-site-association`).
 *
 * They are served HERE, by the `allo-frontend` Worker, because `allo.you` is this
 * Worker and nothing else (`wrangler.toml`). Before this module nothing claimed
 * these paths, so the assets binding's single-page-application fallback answered
 * both with `index.html` and status 200, which neither Android nor iOS accepts,
 * and every Allo link opened in the browser (OxyHQ/Allo#176). Every other
 * `/.well-known/` path now ends in a JSON 404 as well, so a missing document can
 * never again masquerade as the app shell. The shape mirrors Mention's
 * `packages/backend/src/routes/appAssociation.routes.ts` (OxyHQ/Mention#1128).
 *
 * Both verifiers require the document at exactly this path, with no redirect and
 * a JSON body. `__tests__/appAssociation.test.ts` pins the ids below to
 * `app.config.js`, so renaming the app cannot silently break verification.
 *
 * Configuration lives in `[vars]` in `wrangler.toml`, so it ships with a deploy
 * rather than living only in the Cloudflare dashboard:
 *
 * - `APPLE_TEAM_ID`: the Apple Developer Team ID that signs the iOS app. It
 *   appears nowhere in this repository or its EAS config, and a guessed value
 *   would publish a wrong association, so while it is empty the AASA answers a
 *   JSON 404 instead of a document that cannot verify.
 * - `ANDROID_EXTRA_SHA256_CERT_FINGERPRINTS`: comma-separated SHA-256 signing
 *   certificate fingerprints to trust IN ADDITION to the Oxy release key below —
 *   the Google Play app-signing key once Play App Signing is on (Play Console ->
 *   Test and release -> App integrity), or every Play-installed copy fails
 *   verification.
 */

/** `android.package` of the production app (`app.config.js`). */
export const ANDROID_PACKAGE = 'com.allo.app';

/** `ios.bundleIdentifier` of the production app (`app.config.js`). */
export const IOS_BUNDLE_ID = 'com.allo.ios';

/**
 * The Oxy ecosystem release key (`CN=Oxy, OU=Oxy Ecosystem`, alias `oxy`). Every
 * Oxy app MUST be signed with it: the signature-level so.oxy.permission.* that
 * reach Commons are granted only to the same certificate, so it is the key a
 * release build of Allo carries.
 * Read from the keystore itself, and the same value Mention publishes.
 */
export const OXY_RELEASE_CERT_SHA256 =
  'B8:AB:37:46:46:6C:E4:56:9D:7A:6A:0F:FA:1E:ED:91:BC:37:51:74:D5:03:61:39:87:CA:09:CB:33:D6:A5:8D';

/**
 * The React Native template DEBUG keystore (`CN=Android Debug`, password
 * `android`). Its private key ships inside countless npm packages, so trusting it
 * would let anyone sign a `com.allo.app` that owns our links. Refused even when
 * configured.
 */
export const PUBLIC_DEBUG_CERT_SHA256 =
  'FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C';

const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const TEAM_ID = /^[A-Z0-9]{10}$/;

export const ASSET_LINKS_PATH = '/.well-known/assetlinks.json';
export const AASA_PATH = '/.well-known/apple-app-site-association';

/**
 * Paths an iOS Universal Link may open in the app, first match wins: every app
 * route, the same set the Android `autoVerify` filter claims, minus the files
 * this Worker serves that are not screens.
 */
export const APPLE_APP_LINK_COMPONENTS = [
  { '/': '/.well-known/*', exclude: true },
  { '/': '/_expo/*', exclude: true },
  { '/': '/assets/*', exclude: true },
  { '/': '/*' },
];

/** Verifiers re-fetch on their own schedule; an hour keeps a key rotation quick. */
const CACHE_CONTROL = 'public, max-age=3600';

/** The signing fingerprints to publish: the release key plus the configured, valid extras. */
export function androidFingerprints(env = {}) {
  const extra = String(env.ANDROID_EXTRA_SHA256_CERT_FINGERPRINTS ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value) => FINGERPRINT.test(value) && value !== PUBLIC_DEBUG_CERT_SHA256);
  return [...new Set([OXY_RELEASE_CERT_SHA256, ...extra])];
}

/** The configured Team ID, or `null` when it is missing or not shaped like one. */
export function appleTeamId(env = {}) {
  const value = String(env.APPLE_TEAM_ID ?? '').trim();
  return TEAM_ID.test(value) ? value : null;
}

export function buildAssetLinks(env = {}) {
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE,
        sha256_cert_fingerprints: androidFingerprints(env),
      },
    },
  ];
}

export function buildAppleAppSiteAssociation(env = {}) {
  const teamId = appleTeamId(env);
  if (!teamId) return null;
  return {
    applinks: {
      details: [{ appIDs: [`${teamId}.${IOS_BUNDLE_ID}`], components: APPLE_APP_LINK_COMPONENTS }],
    },
  };
}

function json(body, status, cacheControl, method) {
  return new Response(method === 'HEAD' ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * The response for a `/.well-known/` request, or `null` for any other path,
 * which the caller hands to the assets binding as before.
 */
export function handleWellKnown(request, env = {}) {
  const { pathname } = new URL(request.url);
  if (pathname !== '/.well-known' && !pathname.startsWith('/.well-known/')) return null;

  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    const response = json({ error: 'Method not allowed' }, 405, 'no-store', method);
    response.headers.set('Allow', 'GET, HEAD');
    return response;
  }

  if (pathname === ASSET_LINKS_PATH) {
    return json(buildAssetLinks(env), 200, CACHE_CONTROL, method);
  }
  if (pathname === AASA_PATH) {
    const aasa = buildAppleAppSiteAssociation(env);
    return aasa ? json(aasa, 200, CACHE_CONTROL, method) : json({ error: 'Not found' }, 404, 'no-store', method);
  }
  return json({ error: 'Not found' }, 404, 'no-store', method);
}
