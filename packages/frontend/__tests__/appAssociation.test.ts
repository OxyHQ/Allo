import path from 'path';

import {
  AASA_PATH,
  ANDROID_PACKAGE,
  ASSET_LINKS_PATH,
  IOS_BUNDLE_ID,
  OXY_RELEASE_CERT_SHA256,
  PUBLIC_DEBUG_CERT_SHA256,
  handleWellKnown,
} from '../worker/appAssociation.js';

/**
 * `allo.you` ANSWERS THE APP LINKS VERIFIERS WITH JSON, NOT THE APP SHELL.
 *
 * The Worker's assets binding answers any unknown path with `index.html` and
 * 200, so until `worker/appAssociation.js` existed both well-known documents
 * were the SPA and no https link could open the app (OxyHQ/Allo#176).
 */

const ORIGIN = 'https://allo.you';
const PLAY_KEY = '12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0';

function get(pathname: string, env: Record<string, string> = {}, method = 'GET'): Response | null {
  return handleWellKnown(new Request(`${ORIGIN}${pathname}`, { method }), env);
}

function loadAppConfig() {
  const saved = process.env.APP_VARIANT;
  delete process.env.APP_VARIANT;
  try {
    jest.resetModules();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const factory = require(path.join(__dirname, '..', 'app.config.js')) as (config: unknown) => {
      expo: { android: { package: string }; ios: { bundleIdentifier: string } };
    };
    return factory({}).expo;
  } finally {
    if (saved !== undefined) process.env.APP_VARIANT = saved;
  }
}

describe('assetlinks.json', () => {
  it('is 200 application/json naming the production package and the Oxy release key', async () => {
    const response = get(ASSET_LINKS_PATH)!;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: 'com.allo.app',
          sha256_cert_fingerprints: [OXY_RELEASE_CERT_SHA256],
        },
      },
    ]);
  });

  it('adds configured fingerprints (the Play app-signing key) and drops malformed ones', async () => {
    const response = get(ASSET_LINKS_PATH, {
      ANDROID_EXTRA_SHA256_CERT_FINGERPRINTS: ` ${PLAY_KEY.toLowerCase()} , not-a-key, ${OXY_RELEASE_CERT_SHA256}`,
    })!;
    const [statement] = await response.json();
    expect(statement.target.sha256_cert_fingerprints).toEqual([OXY_RELEASE_CERT_SHA256, PLAY_KEY]);
  });

  it('never publishes the public React Native debug key, even when configured', async () => {
    const response = get(ASSET_LINKS_PATH, { ANDROID_EXTRA_SHA256_CERT_FINGERPRINTS: PUBLIC_DEBUG_CERT_SHA256 })!;
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain('FA:C6:17:45');
  });

  it('answers HEAD with the same headers and no body', async () => {
    const response = get(ASSET_LINKS_PATH, {}, 'HEAD')!;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('');
  });
});

describe('apple-app-site-association', () => {
  it('is a JSON 404 while no Team ID is configured, never the SPA', async () => {
    for (const env of [{}, { APPLE_TEAM_ID: '' }, { APPLE_TEAM_ID: 'TEAM' }] as Record<string, string>[]) {
      const response = get(AASA_PATH, env)!;
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(await response.json()).toEqual({ error: 'Not found' });
    }
  });

  it('with a Team ID, is 200 application/json for the production bundle id', async () => {
    const response = get(AASA_PATH, { APPLE_TEAM_ID: 'ABCDE12345' })!;
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = await response.json();
    expect(body.applinks.details[0].appIDs).toEqual(['ABCDE12345.com.allo.ios']);
    expect(body.applinks.details[0].components.at(-1)).toEqual({ '/': '/*' });
  });
});

describe('other paths', () => {
  it('ends every other /.well-known path in a JSON 404', async () => {
    for (const pathname of ['/.well-known', '/.well-known/', '/.well-known/security.txt', '/.well-known/assetlinks']) {
      const response = get(pathname)!;
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('application/json');
    }
  });

  it('refuses writes', () => {
    const response = get(ASSET_LINKS_PATH, {}, 'POST')!;
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });

  it('leaves app routes to the assets binding', () => {
    for (const pathname of ['/', '/c/abc', '/@alice', '/dm/alice', '/well-known/assetlinks.json']) {
      expect(get(pathname)).toBeNull();
    }
  });
});

describe('the ids match the app that is built', () => {
  it('names the package and bundle id of the production app config', () => {
    const config = loadAppConfig();
    expect(ANDROID_PACKAGE).toBe(config.android.package);
    expect(IOS_BUNDLE_ID).toBe(config.ios.bundleIdentifier);
  });
});
