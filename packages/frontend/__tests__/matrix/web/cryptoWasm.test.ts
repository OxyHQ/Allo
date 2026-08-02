import { CRYPTO_WASM_URL, CryptoWasmLoader } from '@/lib/matrix/web/cryptoWasm';

/**
 * When the 7.8 MB crypto module is fetched, and how often.
 *
 * These are the cases that hold down a decision rather than an algorithm: the
 * module is deferred until something needs to decrypt, it is fetched once no
 * matter how many callers ask, and a failure is reported as the permanent thing
 * it is instead of being retried into a loop.
 */

describe('CryptoWasmLoader', () => {
  it('fetches nothing until something asks it to', () => {
    // The whole point of the deferral: constructing the client, drawing a login
    // screen and never getting as far as a session must not cost the download.
    let calls = 0;
    new CryptoWasmLoader(async () => {
      calls += 1;
    });

    expect(calls).toBe(0);
  });

  it('loads from the URL the web export serves the module from', async () => {
    // Not a detail: the package's default loader resolves a path the export does
    // not contain, and the SPA fallback answers it with index.html, so the
    // failure reads as a WebAssembly MIME type error.
    const urls: string[] = [];
    const loader = new CryptoWasmLoader(async (url) => {
      urls.push(url);
    });

    await loader.load();

    expect(urls).toEqual([CRYPTO_WASM_URL]);
  });

  it('downloads once, however many callers ask and however they overlap', async () => {
    let calls = 0;
    let release = (): void => {};
    const loader = new CryptoWasmLoader(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });

    const first = loader.load();
    const second = loader.load();
    release();
    await Promise.all([first, second]);
    await loader.load();

    expect(calls).toBe(1);
  });

  it('keeps reporting a failed load without asking again', async () => {
    // The package caches its own promise and hands the same rejection to every
    // later caller, so a retry cannot succeed — it can only make the network
    // look busy while reporting the first failure again.
    let calls = 0;
    const loader = new CryptoWasmLoader(async () => {
      calls += 1;
      throw new Error('Incorrect response MIME type. Expected "application/wasm"');
    });

    await expect(loader.load()).rejects.toThrow('Incorrect response MIME type');
    await expect(loader.load()).rejects.toThrow('Incorrect response MIME type');
    expect(calls).toBe(1);
  });
});
