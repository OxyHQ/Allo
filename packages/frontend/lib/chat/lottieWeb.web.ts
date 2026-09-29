/**
 * Web: point dotLottie at the WebAssembly renderer SERVED BY THIS ORIGIN.
 *
 * Left alone, dotLottie fetches that binary from a public npm CDN — a third
 * party every sticker would depend on. Bundled as an asset, it ships with the
 * app under a content hash. Compiling it needs `'wasm-unsafe-eval'` in any CSP
 * the page is served with.
 *
 * If this is ever skipped, Bloom's `Sticker` does not break: it shows the
 * sticker's still image instead of the animation.
 */
import { setWasmUrl } from '@lottiefiles/dotlottie-react';
import { Asset } from 'expo-asset';

let configured = false;

export function configureLottieWeb(): void {
  if (configured) return;
  configured = true;
  // An asset is required, not imported: Metro turns this into the hashed
  // `/assets/…wasm` URL. There is no ES import form for a binary asset.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  setWasmUrl(Asset.fromModule(require('@lottiefiles/dotlottie-web/dotlottie-player.wasm')).uri);
}
