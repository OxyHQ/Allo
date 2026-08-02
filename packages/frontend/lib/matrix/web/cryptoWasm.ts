/**
 * Loading the Rust crypto machine, which on web is 7.8 MB of WebAssembly.
 *
 * Two decisions live here, and both of them are load-bearing.
 *
 * **Where the module comes from.** The package's default loader resolves its
 * `.wasm` through `import.meta.url`, which under Expo's web export points at
 * `/_expo/static/js/web/pkg/matrix_sdk_crypto_wasm_bg.wasm` — a path the export
 * does not contain. It does not even fail as a 404: the SPA fallback in
 * `public/_redirects` answers it with `index.html`, so the error that surfaces is
 * a WebAssembly MIME type error and sends whoever reads it looking for a server
 * misconfiguration. `initAsync(url)` with an explicit URL is therefore not a
 * nicety, it is the only way this works. `scripts/copy-matrix-wasm.js` is what
 * puts the file at {@link CRYPTO_WASM_URL}; the two have to agree.
 *
 * **When it is loaded.** Not on import, and not when the client is built: only
 * when a session exists and encryption is about to be brought up. The spike
 * measured that opening the app fetches three resources and none of them is the
 * `.wasm` (`spikes/matrix-web/RESULTS.md`), so deferral is the package's default
 * behaviour and all this class does is refuse to give it up — the module is only
 * touched from {@link CryptoWasmLoader.load}. That matters because the 7.8 MB
 * (about 2 MB over the wire once compressed) is roughly the weight of Allo's
 * entire JavaScript bundle, and a user looking at the login screen has no use for
 * a crypto machine.
 *
 * The other end of the window is just as fixed: the load has to happen *before*
 * anything reaches `initRustCrypto()`, because the SDK calls the package's
 * `initAsync` with no argument, and whichever call happens first decides the URL
 * for the life of the page.
 *
 * Nothing here imports the SDK: the loader is handed its `initAsync`, which is
 * what lets this be tested without a browser or a 7.8 MB fixture.
 */

/**
 * Where the crypto WebAssembly module is served from.
 *
 * A fixed path with no content hash, which is deliberate but has a consequence:
 * a long `Cache-Control` would pin one build's `.wasm` forever, so
 * `public/_headers` keeps this one file revalidating. If that ever costs too
 * much, the fix is a content-addressed name here and in the copy script, not a
 * longer cache on a mutable URL.
 */
export const CRYPTO_WASM_URL = '/matrix_sdk_crypto_wasm_bg.wasm';

/**
 * The shape of `initAsync` from `@matrix-org/matrix-sdk-crypto-wasm`.
 *
 * The package's own signature takes `URL | string | undefined`; this narrows it
 * to the one call this port makes.
 */
export type CryptoWasmInit = (url: string) => Promise<void>;

/**
 * Fetches and instantiates the crypto WebAssembly module, once.
 *
 * Once, in a strong sense: the promise is remembered whether it resolves or
 * rejects. A failed load is permanent for the life of the page, and not because
 * this class gives up — the package caches its own promise internally and returns
 * that same rejected promise to every later caller, so a retry would report the
 * first failure again without touching the network. Reporting that plainly beats
 * a retry loop that cannot succeed.
 */
export class CryptoWasmLoader {
  readonly #init: CryptoWasmInit;
  readonly #url: string;

  #loading: Promise<void> | undefined;

  constructor(init: CryptoWasmInit, url: string = CRYPTO_WASM_URL) {
    this.#init = init;
    this.#url = url;
  }

  /**
   * Resolves once the module is ready to be used.
   *
   * Concurrent callers share one download; this is the only place in the port
   * that causes those bytes to be fetched.
   */
  load(): Promise<void> {
    this.#loading ??= this.#init(this.#url);
    return this.#loading;
  }
}
