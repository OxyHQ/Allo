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
 * One constraint that is not a caveat but a requirement, because getting it wrong
 * fails in a way that sends you looking in the wrong place: **`initAsync(url)`
 * must be called explicitly**, before anything that reaches `initRustCrypto()`.
 * The package's default loader resolves the `.wasm` through `import.meta.url`,
 * which under Expo's web export points at a path that is not there — and the SPA
 * fallback in `packages/frontend/public/_redirects` answers it with `index.html`
 * rather than a 404, so what surfaces is a WebAssembly MIME type error and not a
 * missing file. `spikes/matrix-web/RESULTS.md` has that and four more
 * restrictions, including the three ordered calls that stand in for the native
 * binding's single `recover()`.
 *
 * Two things whoever writes this should not assume are settled, because the same
 * spike says they are not:
 *
 * - **OIDC is only half proven on web.** Discovery and building the authorization
 *   URL work; no login was ever completed, so neither dynamic client registration
 *   nor the code exchange has been exercised. That is exactly the half this port's
 *   `AlloOidcLoginRequest` depends on, and Allo has no other way in.
 * - **Two tabs remain a hazard.** The spike could not reproduce the corruption the
 *   `matrix-js-sdk` documentation warns about, but it could not rule it out
 *   either: the warning describes a race, and minutes of testing do not force
 *   one. A lock across tabs still has to be budgeted for.
 *
 * Until then the factory throws rather than returning a client that quietly does
 * nothing, because a stub is how a platform ends up shipping with its messaging
 * silently broken.
 */
export const createAlloChatClient: AlloChatClientFactory = () => {
  throw new MatrixPlatformUnsupportedError(
    'web',
    'matrix-js-sdk plus matrix-sdk-crypto-wasm is proven viable under the Expo ' +
      'web export but has not been wired up to this port yet',
  );
};
