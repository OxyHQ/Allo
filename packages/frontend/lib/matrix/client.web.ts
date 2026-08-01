import { MatrixPlatformUnsupportedError } from '@/lib/matrix/errors';
import type { AlloChatClientFactory } from '@/lib/matrix/types';

/**
 * The web half of the chat port — the hole where it goes, rather than the thing
 * itself.
 *
 * Web cannot use the binding this port's native half is built on: the Rust SDK
 * has no JavaScript binding of the client, only of its crypto machine, and Hermes
 * does not run WebAssembly anyway. The replacement is `matrix-js-sdk@42` +
 * `@matrix-org/matrix-sdk-crypto-wasm@18` with `/sync` v2
 * (`docs/matrix/client-strategy.md` §2.1), and the one risk that decision rested
 * on — that the `.wasm` would not survive `expo export --platform web`, because
 * Metro resolves that asset differently from a web bundler — has been settled:
 * the spike in `spikes/matrix-web` loads and instantiates it from a production
 * export, and gets an encrypted round trip and a key-backup recovery out of it.
 *
 * So what is missing here is the work, not the answer. Until it is written the
 * factory throws rather than returning a client that quietly does nothing,
 * because a stub is how a platform ends up shipping with its messaging silently
 * broken.
 */
export const createAlloChatClient: AlloChatClientFactory = () => {
  throw new MatrixPlatformUnsupportedError(
    'web',
    'matrix-js-sdk plus matrix-sdk-crypto-wasm is proven viable under the Expo ' +
      'web export but has not been wired up to this port yet',
  );
};
