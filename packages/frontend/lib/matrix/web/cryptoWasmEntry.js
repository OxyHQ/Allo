/**
 * The web entry for `@matrix-org/matrix-sdk-crypto-wasm`.
 *
 * Neither entry the package ships can be bundled by Metro, and both fail at
 * MODULE SCOPE — before any of our code runs, so no argument passed to
 * `initAsync` can prevent it:
 *
 *   index.mjs  `new URL("./pkg/…wasm", import.meta.url)`
 *              Metro gives `import.meta.url` no usable value on web.
 *              -> TypeError: Failed to construct 'URL': Invalid base URL
 *
 *   index.cjs  `require.resolve("./pkg/…wasm")`
 *              Metro's runtime `require` has no `resolve`.
 *              -> TypeError: r.resolve is not a function
 *
 * Both surfaced identically in production, as "Allo could not start its Matrix
 * client", with nothing naming the SDK.
 *
 * This is index.mjs with the one hazardous line removed. Everything else is
 * upstream's, including the import-object key `WebAssembly.instantiateStreaming`
 * is given, which must match the name the wasm was compiled against.
 *
 * The difference: `initAsync` takes the URL and has no default. There is nothing
 * to compute at import time, so there is nothing to go wrong before a caller
 * arrives. `lib/matrix/web/cryptoWasm.ts` is that caller and already passes an
 * explicit URL.
 *
 * `metro.config.js` maps the package to this file, and the bare specifier below
 * to the package's generated wrappers — the package's `exports` map declares
 * only `.`, so neither path can be written directly.
 *
 * When upstream is bundleable, delete this file and both mappings. Check
 * whether that line still evaluates at module scope before doing so.
 */

// eslint-disable-next-line import/no-unresolved -- resolved by metro.config.js
import * as bindings from 'matrix-sdk-crypto-wasm-bindings';

/** @type {Promise<void> | null} */
let modPromise = null;

/**
 * @param {URL | string} url
 * @returns {Promise<void>}
 */
async function loadModuleAsync(url) {
  const { instance } = await WebAssembly.instantiateStreaming(fetch(url), {
    './matrix_sdk_crypto_wasm_bg.js': bindings,
  });

  bindings.__wbg_set_wasm(instance.exports);
  instance.exports.__wbindgen_start();
}

/**
 * Loads the WebAssembly module, once. Concurrent callers share one download.
 *
 * @param {URL | string} url Required, unlike upstream — see the note above.
 * @returns {Promise<void>}
 */
export async function initAsync(url) {
  if (url === undefined || url === '') {
    throw new Error(
      'initAsync needs the URL of matrix_sdk_crypto_wasm_bg.wasm. There is no ' +
        'default here on purpose: computing one is what makes the upstream ' +
        'entries fail to bundle.',
    );
  }
  if (!modPromise) modPromise = loadModuleAsync(url);
  await modPromise;
}

export * from 'matrix-sdk-crypto-wasm-bindings';
