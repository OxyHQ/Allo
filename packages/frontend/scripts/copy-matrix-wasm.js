// Copies the Matrix crypto WebAssembly module into `public/`, from where Expo
// copies it verbatim into the web export and Cloudflare Pages serves it.
//
// This exists because the package's own loader resolves the .wasm through
// `import.meta.url`, which under Metro points at a path the export does not
// contain — and the SPA fallback in `public/_redirects` answers that path with
// `index.html` rather than a 404, so the failure surfaces as a WebAssembly MIME
// type error. `lib/matrix/web/cryptoWasm.ts` passes the URL below to
// `initAsync()` explicitly instead; the two have to agree, and this script is
// what makes the file exist at it.
//
// It runs before every web build and before the dev server. The copy is ~7.8 MB
// and does not belong in git, so `public/` ignores it.
const fs = require('node:fs');
const path = require('node:path');

// Must match CRYPTO_WASM_URL in lib/matrix/web/cryptoWasm.ts.
const PUBLIC_FILENAME = 'matrix_sdk_crypto_wasm_bg.wasm';

// `require.resolve` of the package itself rather than of the .wasm: the package
// does not export the asset, and resolving its entry point works whether bun
// hoisted it to the workspace root or kept it here.
const packageRoot = path.dirname(require.resolve('@matrix-org/matrix-sdk-crypto-wasm'));
const source = path.join(packageRoot, 'pkg', PUBLIC_FILENAME);
const target = path.join(__dirname, '..', 'public', PUBLIC_FILENAME);

if (!fs.existsSync(source)) {
  console.error(
    `[matrix] ${source} is missing. Install dependencies from the monorepo root ` +
      'with `bun install` before building for web.',
  );
  process.exit(1);
}

// Skipping an unchanged copy keeps `expo start` from rewriting 7.8 MB on every
// launch, which the dev server would notice as a change in `public/`.
const sourceStat = fs.statSync(source);
const targetStat = fs.existsSync(target) ? fs.statSync(target) : undefined;
if (targetStat !== undefined && targetStat.size === sourceStat.size && targetStat.mtimeMs >= sourceStat.mtimeMs) {
  console.log(`[matrix] public/${PUBLIC_FILENAME} is up to date (${sourceStat.size} bytes)`);
  process.exit(0);
}

fs.copyFileSync(source, target);
console.log(`[matrix] copied ${sourceStat.size} bytes -> public/${PUBLIC_FILENAME}`);
