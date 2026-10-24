// Learn more https://docs.expo.dev/guides/customizing-metro
//
// The shared Oxy Metro config (`@oxy.so/app-preset/metro`): monorepo watch
// folders and block list, symlink + package-exports resolution, the web-font
// and `.wasm` asset extensions (Bloom's `.woff2` fonts on web; dotLottie's
// renderer, which draws stickers on the web and is served from this origin by
// `lib/chat/lottieWeb.web.ts`), the release minifier, NativeWind, the Bloom
// single-instance rewrite and the complete `react-native` shim NativeWind needs
// on React Native 0.88 (`AssetRegistry`; without it every `useFonts` fails and
// an Android release renders a blank window). Allo adds only its own resolver
// aliases on top, below.
const path = require('node:path');
const fs = require('node:fs');
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

/** @type {import('expo/metro-config').MetroConfig} */
const config = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@allo/shared-types',
  // NativeWind (v5) entry. The preset keeps `inlineVariables: false` (Bloom's
  // `BloomColorScope` token aliases resolve at runtime) and `inlineRem: 16`.
  cssInput: './styles/global.css',
});

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
    return fs.existsSync(entry) ? entry : null;
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
      ['@oxy.so/services/ui/client', path.resolve(__dirname, 'harness/oxy-services.tsx')],
      ['@oxy.so/core', path.resolve(__dirname, 'harness/oxy-core.ts')],
      ['@/lib/allo/client', path.resolve(__dirname, 'harness/client.ts')],
    ])
  : new Map();

// The preset's finished resolver (NativeWind, Bloom single instance, the
// complete `react-native` shim). Allo's aliases run first and hand every other
// request — `react-native` and `react-native-css/components` included —
// down to it unchanged, as the preset requires of an app-level wrapper.
const presetResolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const harnessAlias = HARNESS_ALIASES.get(moduleName);
  if (harnessAlias && !context.originModulePath.includes('/harness/')) {
    return { type: 'sourceFile', filePath: harnessAlias };
  }
  // `./client` only where AlloRoot asks for it — the SDK has a module of that name too.
  if (
    HARNESS &&
    moduleName === './client' &&
    context.originModulePath.endsWith('/lib/allo/AlloRoot.tsx')
  ) {
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
  return presetResolveRequest(context, moduleName, platform);
};

module.exports = config;
