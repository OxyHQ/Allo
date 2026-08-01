import { MatrixPlatformUnsupportedError } from '@/lib/matrix/errors';
import type { AlloChatClientFactory } from '@/lib/matrix/types';

/**
 * The web half of the chat port — the hole where it goes, rather than the thing
 * itself.
 *
 * Web cannot use the binding this port's native half is built on: the Rust SDK
 * has no JavaScript binding of the client, only of its crypto machine, and Hermes
 * does not run WebAssembly anyway. The decided replacement is
 * `matrix-js-sdk@42` + `@matrix-org/matrix-sdk-crypto-wasm@18` with `/sync` v2
 * (`docs/matrix/client-strategy.md` §2.1), and the one thing that decision still
 * rests on is unverified: that both survive `expo export --platform web` under
 * Metro, which resolves the `.wasm` asset differently from a web bundler. A spike
 * is settling that; the implementation lands here once it does.
 *
 * It throws rather than returning a client that quietly does nothing, because a
 * stub is how a platform ends up shipping with its messaging silently broken.
 */
export const createAlloChatClient: AlloChatClientFactory = () => {
  throw new MatrixPlatformUnsupportedError(
    'web',
    'matrix-js-sdk plus matrix-sdk-crypto-wasm has not been wired up yet, ' +
      'pending the spike that checks it survives the Expo web export',
  );
};
