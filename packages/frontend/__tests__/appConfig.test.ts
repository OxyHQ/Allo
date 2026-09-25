import path from 'path';

/**
 * WHICH LINKS THE BUILT APP CLAIMS.
 *
 * Every https host in an `autoVerify` intent filter is checked by Android
 * against that host's `/.well-known/assetlinks.json`, and on Android 11 and
 * below a single host that fails verification fails the whole filter. Three
 * wrong hosts have shipped in this filter:
 *
 *  - `oxy.so`, which publishes no assetlinks for Allo's package (Mention removed
 *    the same entry, OxyHQ/Mention#1128);
 *  - `allo.chat`, which does not resolve in DNS, while the real web app,
 *    `allo.you`, was not listed at all (OxyHQ/Allo#176);
 *  - `http://localhost:4140`, meant for development builds only, which a variant
 *    check that was true for EVERY build put into production (OxyHQ/Allo#176).
 */

interface IntentFilter {
  autoVerify?: boolean;
  data: ({ scheme?: string; host?: string } | false)[];
}

interface ExpoConfig {
  android: { package: string; intentFilters: IntentFilter[] };
  ios: { bundleIdentifier: string; associatedDomains?: string[] };
}

type Env = { EXPO_PUBLIC_ENV?: string; APP_VARIANT?: string; EAS_BUILD_PLATFORM?: string };

const ENV_KEYS = ['EXPO_PUBLIC_ENV', 'APP_VARIANT', 'EAS_BUILD_PLATFORM'] as const;

function loadAppConfig(env: Env): ExpoConfig {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    jest.resetModules();
    // app.config.js is CommonJS and reads the env when CALLED, so it is loaded here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const factory = require(path.join(__dirname, '..', 'app.config.js')) as (config: unknown) => {
      expo: ExpoConfig;
    };
    return factory({}).expo;
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function verifiedHosts(filters: IntentFilter[]): string[] {
  return filters
    .filter((filter) => filter.autoVerify)
    .flatMap((filter) => filter.data)
    .flatMap((entry) => (entry && entry.scheme === 'https' && entry.host ? [entry.host] : []));
}

/** Anything that names this machine or a private network rather than a public host. */
const LOCAL_HOST = /localhost|127\.0\.0\.1|10\.0\.2\.2|0\.0\.0\.0|\.local\b|:4140|:8140/;

/** Every build the stores receive: the EAS profiles set `EXPO_PUBLIC_ENV` to these, or nothing. */
const PRODUCTION_BUILDS: Env[] = [
  {},
  { EXPO_PUBLIC_ENV: 'production' },
  { EXPO_PUBLIC_ENV: 'testflight' },
  { EXPO_PUBLIC_ENV: 'production', EAS_BUILD_PLATFORM: 'android' },
  { EXPO_PUBLIC_ENV: 'production', EAS_BUILD_PLATFORM: 'ios' },
];

describe.each(PRODUCTION_BUILDS)('production app config (%j)', (env) => {
  const config = loadAppConfig(env);

  it('is the production app', () => {
    expect(config.android.package).toBe('com.allo.app');
    expect(config.ios.bundleIdentifier).toBe('com.allo.ios');
  });

  it('names no localhost or other development host anywhere', () => {
    expect(JSON.stringify(config)).not.toMatch(LOCAL_HOST);
  });

  it('verifies exactly allo.you, the host that serves assetlinks.json', () => {
    expect(verifiedHosts(config.android.intentFilters)).toEqual(['allo.you']);
  });

  it('claims no host outside Allo: not oxy.so, not the dead allo.chat', () => {
    const hosts = config.android.intentFilters
      .flatMap((filter) => filter.data)
      .flatMap((entry) => (entry && entry.host ? [entry.host] : []));
    expect(hosts.filter((host) => /(^|\.)oxy\.so$|allo\.chat/.test(host))).toEqual([]);
  });

  it('has only verified https entries, so no host can fail the filter', () => {
    for (const filter of config.android.intentFilters) {
      expect(filter.autoVerify).toBe(true);
      for (const entry of filter.data) expect(entry && entry.scheme).toBe('https');
    }
  });

  it('associates the same host for iOS Universal Links', () => {
    expect(config.ios.associatedDomains).toEqual(['applinks:allo.you']);
  });
});

describe('development variant', () => {
  const config = loadAppConfig({ APP_VARIANT: 'development' });

  it('is a separate app that also opens the local web server, outside the verified filter', () => {
    expect(config.android.package).toBe('com.allo.app.dev');
    expect(JSON.stringify(config)).toMatch(/localhost/);
    expect(verifiedHosts(config.android.intentFilters)).toEqual(['allo.you']);
    const verified = config.android.intentFilters.filter((filter) => filter.autoVerify);
    expect(JSON.stringify(verified)).not.toMatch(LOCAL_HOST);
  });
});
