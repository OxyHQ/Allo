import type { OAuthAuthorizationDataLike } from '@unomed/react-native-matrix-sdk';

import { MatrixOidcLoginSettledError } from '@/lib/matrix/errors';
import type { AlloOidcLoginRequest, AlloSession } from '@/lib/matrix/types';

import { toAlloSession, type SessionFields } from './translate';

/**
 * What an in-flight authorization needs of the client, rather than the whole
 * `ClientLike`: the SDK's client satisfies it structurally, so the compiler still
 * checks it where the request is built.
 */
export interface OidcLoginClient {
  loginWithOidcCallback(callbackUrl: string): Promise<void>;
  abortOidcAuth(authorizationData: OAuthAuthorizationDataLike): Promise<void>;
  session(): SessionFields;
}

/**
 * One authorization, from the URL the browser is sent to until it is finished or
 * abandoned.
 *
 * The state exists because the SDK holds server-side state for an attempt —
 * `abortOidcAuth` is what releases it — and because both terminal steps are
 * reachable twice in normal use: a redirect can fire more than once, and a user
 * can close the browser on an attempt the app is about to complete. Letting a
 * second call through would either abort a login that had already succeeded or
 * feed the same authorization code to the server twice.
 */
export class NativeOidcLoginRequest implements AlloOidcLoginRequest {
  readonly #client: OidcLoginClient;
  readonly #authorizationData: OAuthAuthorizationDataLike;
  readonly authorizationUrl: string;

  #settled = false;

  constructor(client: OidcLoginClient, authorizationData: OAuthAuthorizationDataLike) {
    this.#client = client;
    this.#authorizationData = authorizationData;
    this.authorizationUrl = authorizationData.loginUrl();
  }

  async complete(callbackUrl: string): Promise<AlloSession> {
    this.#settle('complete');
    await this.#client.loginWithOidcCallback(callbackUrl);
    return toAlloSession(this.#client.session());
  }

  async abort(): Promise<void> {
    this.#settle('abort');
    await this.#client.abortOidcAuth(this.#authorizationData);
  }

  #settle(attempted: string): void {
    if (this.#settled) {
      throw new MatrixOidcLoginSettledError(attempted);
    }
    // Marked before the call, not after: a failed completion has still consumed
    // the authorization code, and retrying it would only ask the server to accept
    // a code it has already seen.
    this.#settled = true;
  }
}
