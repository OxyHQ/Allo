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

// Enable NativeWind (v5) CSS support. `inlineVariables: false` keeps CSS custom
// properties as runtime variables (required so Bloom's `BloomColorScope` token
// aliases resolve at runtime instead of being inlined at build time); `inlineRem`
// pins the rem base to 16.
module.exports = withNativeWind(config, {
  input: './styles/global.css',
  inlineRem: 16,
  inlineVariables: false,
});

