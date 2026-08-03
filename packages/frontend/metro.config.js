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

// `@matrix-org/matrix-sdk-crypto-wasm` cannot be loaded through its ESM entry
// here. `index.mjs` evaluates, at module scope:
//
//   const defaultURL = new URL("./pkg/matrix_sdk_crypto_wasm_bg.wasm", import.meta.url);
//
// Metro's web output gives `import.meta.url` no usable value, so that line throws
// `Failed to construct 'URL': Invalid base URL` the moment the module is
// imported — before `initAsync` is reached, which means passing an explicit URL
// to `initAsync` does not avoid it. In production this surfaced as "Allo could
// not start its Matrix client", with nothing pointing at the SDK.
//
// `index.cjs` is the same bindings without that line: its default is a
// `require.resolve`, which Metro answers with a module id it never has to parse
// as a URL. `lib/matrix/web/cryptoWasm.ts` passes the real URL explicitly, so
// the default is never used either way.
//
// `.wasm` joins `assetExts` because that `require.resolve` has to resolve at
// bundle time. The file Metro emits from it is unused — the copy the app
// actually fetches is placed in `public/` by `scripts/copy-matrix-wasm.js`,
// which every web script runs first.
if (!config.resolver.assetExts.includes('wasm')) {
  config.resolver.assetExts.push('wasm');
}

const CRYPTO_WASM = '@matrix-org/matrix-sdk-crypto-wasm';
// Composed from the package directory rather than asked for as a subpath: the
// package's `exports` map declares only `.`, so `require.resolve` of
// `<pkg>/index.cjs` fails with ERR_PACKAGE_PATH_NOT_EXPORTED. Resolving the
// entry and taking its directory sidesteps the map — `node.cjs` and `index.cjs`
// are siblings at the package root.
const CRYPTO_WASM_CJS = require('path').join(
  require('path').dirname(require.resolve(CRYPTO_WASM)),
  'index.cjs',
);
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === 'web' && moduleName === CRYPTO_WASM) {
    return context.resolveRequest(context, CRYPTO_WASM_CJS, platform);
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

