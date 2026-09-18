// Learn more https://docs.expo.dev/guides/customizing-metro
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Register `.woff2` / `.woff` as Metro asset extensions so `@oxy.so/bloom`'s
// web-only font-face injection (which imports the bundled font binaries from
// `@oxy.so/bloom/lib/module/fonts/assets/`) resolves on `expo export --platform
// web`. Without this, Metro's default `assetExts` (which doesn't include
// `.woff2` or `.woff`) fails to load Bloom's font assets during the web bundle
// pass. Native bundling is unaffected — Bloom's native code path is a no-op
// stub that never imports `.woff2`/`.woff`.
for (const ext of ['woff2', 'woff']) {
  if (!config.resolver.assetExts.includes(ext)) {
    config.resolver.assetExts.push(ext);
  }
}

// ---------------------------------------------------------------------------
// The MLS engine's imports Metro cannot otherwise resolve.
//
// `@allo/core` encrypts with `ts-mls`, and `ts-mls` (through `@hpke/common`)
// carries two kinds of import that exist for other runtimes:
//
//   1. `await import("crypto")` — a Node fallback behind a `globalThis.crypto`
//      check. Neither a browser nor Hermes takes the branch, but Metro resolves
//      every import statically, on BOTH platforms, and "crypto" is not a module
//      it can find. It is pointed at an empty module.
//
//   2. `await import("@hpke/ml-kem")` and its siblings — the optional peers
//      behind ciphersuites Allo does not use. None is installed, so each name
//      is pointed at a stub that throws with the name if anything ever reads
//      from it. Metro's static resolution is satisfied; the suites stay
//      unavailable, which they were anyway.
//
//   3. `@hpke/*` ships two builds, and Metro must take the ESM one. The CJS
//      build (`script/mod.js`, the `require` condition and `main`) is a UMD
//      wrapper whose factory takes a PARAMETER named `require`; Metro's
//      dependency collector only rewrites calls to the global `require`, so
//      every `require("@hpke/common")` inside it is left as a string and fails
//      at runtime with "Requiring unknown module". The client bundle happens to
//      pick the `import` condition; the static-render (node) bundle picks
//      `require`, and that is where it broke. Pointing the package root at
//      `esm/mod.js` makes both bundles take the same, working build.
//
// All three are resolver-level so they apply to every consumer of the SDK and
// to every platform.
// ---------------------------------------------------------------------------
const EMPTY_MODULE = path.resolve(__dirname, 'metro/empty-module.js');
const OPTIONAL_PEER_STUB = path.resolve(__dirname, 'metro/ts-mls-optional-peer.js');

/** `@hpke/<name>` → its ESM entry, or `null` when the package is not installed or has none. */
function hpkeEsmEntry(packageName) {
  try {
    const packageJson = require.resolve(`${packageName}/package.json`, { paths: [__dirname] });
    const entry = path.join(path.dirname(packageJson), 'esm', 'mod.js');
    return require('fs').existsSync(entry) ? entry : null;
  } catch {
    return null;
  }
}

const NODE_CRYPTO_NAMES = new Set(['crypto', 'node:crypto']);
const TS_MLS_OPTIONAL_PEERS = new Set([
  '@hpke/chacha20poly1305',
  '@hpke/ml-kem',
  '@hpke/hybridkem-x-wing',
  '@hpke/dhkem-x448',
  '@noble/post-quantum',
]);

// LOCAL HARNESS (ALLO_HARNESS=1): the Oxy session and the Allo client are
// replaced by in-memory stand-ins so every chat screen can be opened in a
// browser without an account. Never set in CI or a release build.
const HARNESS = process.env.ALLO_HARNESS === '1';
const HARNESS_ALIASES = HARNESS
  ? new Map([
      ['@oxy.so/services', path.resolve(__dirname, 'harness/oxy-services.tsx')],
      ['@oxy.so/core', path.resolve(__dirname, 'harness/oxy-core.ts')],
      ['@/lib/allo/client', path.resolve(__dirname, 'harness/client.ts')],
    ])
  : new Map();

const defaultResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const harnessAlias = HARNESS_ALIASES.get(moduleName);
  if (harnessAlias && !context.originModulePath.includes('/harness/')) {
    return { type: 'sourceFile', filePath: harnessAlias };
  }
  // `./client` only where AlloRoot asks for it — the SDK has a module of that name too.
  if (HARNESS && moduleName === './client' && context.originModulePath.endsWith('/lib/allo/AlloRoot.tsx')) {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'harness/client.ts') };
  }
  if (NODE_CRYPTO_NAMES.has(moduleName)) {
    return { type: 'sourceFile', filePath: EMPTY_MODULE };
  }
  const packageName = moduleName.startsWith('@')
    ? moduleName.split('/').slice(0, 2).join('/')
    : moduleName.split('/')[0];
  if (TS_MLS_OPTIONAL_PEERS.has(packageName)) {
    return { type: 'sourceFile', filePath: OPTIONAL_PEER_STUB };
  }
  if (moduleName.startsWith('@hpke/') && moduleName === packageName) {
    const entry = hpkeEsmEntry(packageName);
    if (entry) return { type: 'sourceFile', filePath: entry };
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

// Enable NativeWind (v5) CSS support. `inlineVariables: false` keeps CSS custom
// properties as runtime variables (required so Bloom's `BloomColorScope` token
// aliases resolve at runtime instead of being inlined at build time); `inlineRem`
// pins the rem base to 16.
module.exports = withNativeWind(config, {
  input: './styles/global.css',
  inlineRem: 16,
  inlineVariables: false,
});
