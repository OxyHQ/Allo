// Copies the crypto WASM artifact into `public/`, which Expo copies verbatim
// into the web export output. This is the escape hatch described in
// docs/matrix/client-strategy.md §2.1 point 2: serve the .wasm from a known URL
// and hand that URL to `initAsync()` instead of relying on `import.meta.url`
// asset resolution.
const fs = require('node:fs');
const path = require('node:path');

const source = path.join(
  __dirname,
  '..',
  'node_modules',
  '@matrix-org',
  'matrix-sdk-crypto-wasm',
  'pkg',
  'matrix_sdk_crypto_wasm_bg.wasm',
);
const publicDir = path.join(__dirname, '..', 'public');
const target = path.join(publicDir, 'matrix_sdk_crypto_wasm_bg.wasm');

fs.mkdirSync(publicDir, { recursive: true });
fs.copyFileSync(source, target);

const { size } = fs.statSync(target);
console.log(`copied ${size} bytes -> ${path.relative(process.cwd(), target)}`);
