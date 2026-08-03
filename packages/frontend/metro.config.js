// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Register `.woff2` / `.woff` as Metro asset extensions so `@oxyhq/bloom`'s
// web-only font-face injection (which imports the bundled font binaries from
// `@oxyhq/bloom/lib/module/fonts/assets/`) resolves on `expo export --platform
// web`. Without this, Metro's default `assetExts` (which doesn't include
// `.woff2` or `.woff`) fails to load Bloom's font assets during the web bundle
// pass. Native bundling is unaffected — Bloom's native code path is a no-op
// stub that never imports `.woff2`/`.woff`.
for (const ext of ['woff2', 'woff']) {
  if (!config.resolver.assetExts.includes(ext)) {
    config.resolver.assetExts.push(ext);
  }
}

// `@matrix-org/matrix-sdk-crypto-wasm` ships two entries and Metro can bundle
// neither. Both fail at MODULE SCOPE, before any of our code runs, so no
// argument to `initAsync` can prevent it:
//
//   index.mjs  `new URL("./pkg/…wasm", import.meta.url)` — Metro gives
//              `import.meta.url` no usable value on web.
//              -> Failed to construct 'URL': Invalid base URL
//   index.cjs  `require.resolve("./pkg/…wasm")` — Metro's runtime `require`
//              has no `resolve`.
//              -> r.resolve is not a function
//
// Both reached production as "Allo could not start its Matrix client".
//
// Web therefore uses our own entry, which is upstream's minus that one line.
// Two mappings are needed rather than one because the package's `exports` map
// declares only `.`: neither `<pkg>/index.cjs` nor `<pkg>/pkg/…_bg.js` can be
// imported by path, and asking for either raises ERR_PACKAGE_PATH_NOT_EXPORTED.
// Resolving the entry and walking up from it sidesteps the map.
const path = require('path');
const CRYPTO_WASM = '@matrix-org/matrix-sdk-crypto-wasm';
const CRYPTO_WASM_BINDINGS = 'matrix-sdk-crypto-wasm-bindings';
const cryptoWasmDir = path.dirname(require.resolve(CRYPTO_WASM));
const cryptoWasmTargets = {
  [CRYPTO_WASM]: path.join(__dirname, 'lib/matrix/web/cryptoWasmEntry.js'),
  [CRYPTO_WASM_BINDINGS]: path.join(cryptoWasmDir, 'pkg/matrix_sdk_crypto_wasm_bg.js'),
};

const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const target = platform === 'web' ? cryptoWasmTargets[moduleName] : undefined;
  if (target !== undefined) {
    return context.resolveRequest(context, target, platform);
  }
  return (upstreamResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
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

