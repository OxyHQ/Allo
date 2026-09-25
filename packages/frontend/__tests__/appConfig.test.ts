import path from 'path';

/**
 * THE APP LINKS FILTER CLAIMS ONLY HOSTS THAT CAN VERIFY FOR ALLO.
 *
 * Every https host in an `autoVerify` intent filter is checked by Android
 * against that host's `/.well-known/assetlinks.json`, and on Android 11 and
 * below a single host that fails verification fails the whole filter. `oxy.so`
 * sat in this filter although Allo opens no oxy.so URL and oxy.so publishes no
 * assetlinks for Allo's package; Mention removed the same entry
 * (OxyHQ/Mention#1128). This keeps it from coming back.
 */

interface IntentFilter {
  autoVerify?: boolean;
  data: ({ scheme?: string; host?: string } | false)[];
}

function loadAppConfig(env: 'production' | 'testflight') {
  const saved = { env: process.env.EXPO_PUBLIC_ENV, variant: process.env.APP_VARIANT };
  process.env.EXPO_PUBLIC_ENV = env;
  delete process.env.APP_VARIANT;
  try {
    jest.resetModules();
    // app.config.js is CommonJS and reads the env when CALLED, so it is loaded here.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const factory = require(path.join(__dirname, '..', 'app.config.js')) as (config: unknown) => {
      expo: { android: { intentFilters: IntentFilter[] } };
    };
    return factory({}).expo;
  } finally {
    if (saved.env === undefined) delete process.env.EXPO_PUBLIC_ENV;
    else process.env.EXPO_PUBLIC_ENV = saved.env;
    if (saved.variant !== undefined) process.env.APP_VARIANT = saved.variant;
  }
}

function verifiedHosts(filters: IntentFilter[]): string[] {
  return filters
    .filter((filter) => filter.autoVerify)
    .flatMap((filter) => filter.data)
    .flatMap((entry) => (entry && entry.scheme === 'https' && entry.host ? [entry.host] : []));
}

describe.each(['production', 'testflight'] as const)('Android App Links (%s)', (env) => {
  it('does not claim oxy.so, which publishes no assetlinks for Allo', () => {
    const hosts = verifiedHosts(loadAppConfig(env).android.intentFilters);
    expect(hosts.length).toBeGreaterThan(0);
    expect(hosts.filter((host) => host === 'oxy.so' || host.endsWith('.oxy.so'))).toEqual([]);
  });
});
