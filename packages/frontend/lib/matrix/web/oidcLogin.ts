import { MatrixOidcCallbackError, MatrixOidcLoginSettledError } from '@/lib/matrix/errors';
import type { AlloOidcLoginRequest, AlloSession } from '@/lib/matrix/types';

/**
 * One authorization, from the URL the browser is sent to until it is finished or
 * abandoned.
 *
 * Same three steps and the same state machine as the native half
 * (`native/oidcLogin.ts`), because they come from OAuth and not from either SDK:
 * the app asks for a URL, hands it to a browser it does not control, and comes
 * back with whatever that browser was redirected to.
 *
 * What differs is what the two steps cost. On web the authorization code is
 * exchanged for tokens by the app itself — `matrix-js-sdk` has no equivalent of
 * the binding's `loginWithOidcCallback`, which does the exchange and installs the
 * session in one call — so the checks that call makes have to be made here. The
 * `state` check is the one that matters: it is what says the authorization that
 * came back is the one this request sent, and skipping it accepts a code from
 * anywhere.
 */

/** What an authorization ends with, before it becomes a session. */
export interface OidcGrant {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  /**
   * The device id the authorization was requested for.
   *
   * Under OIDC this belongs to the client, not the server: it travels inside the
   * requested scope, and the SDK mints one when the caller does not supply it.
   */
  readonly deviceId: string;
}

/**
 * What this module needs of `matrix-js-sdk`'s `OAuth2`, rather than the whole
 * class: the SDK's object satisfies it structurally, so the compiler still checks
 * it where the request is built, and a test does not need a homeserver.
 */
export interface OidcAuthorization {
  readonly context: { readonly deviceId: string };
  completeAuthorizationCodeGrant(code: string): Promise<{
    readonly access_token: string;
    readonly refresh_token?: string;
  }>;
}

/** Turns a grant into a live session. Supplied by the client that owns it. */
export type OidcGrantHandler = (grant: OidcGrant) => Promise<AlloSession>;

/** The two values an authorization response carries back. */
export interface AuthorizationResponse {
  readonly code: string;
  readonly state: string;
}

/**
 * Reads one parameter of an authorization response, wherever it was put.
 *
 * Both the fragment and the query are read. The request asks for the response in
 * the fragment, which is the SDK's default and keeps the authorization code out
 * of the server logs of whatever serves Allo, but an authorization server is free
 * to answer in the query and a response that arrives is better read than dropped.
 *
 * `undefined` rather than a throw for a URL that is not one, because the two
 * callers want opposite things from that case: {@link readAuthorizationResponse}
 * refuses it, and {@link carriesAuthorizationResponse} answers no.
 */
function authorizationParameters(callbackUrl: string): ((name: string) => string | null) | undefined {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    return undefined;
  }
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ''));
  const query = url.searchParams;
  return (name) => fragment.get(name) ?? query.get(name);
}

/**
 * Whether this URL is an authorization server answering, of any kind.
 *
 * What it decides is whether a launch of Allo is the second half of a login that
 * left the page — so a refusal counts. A URL carrying `error=access_denied` is a
 * login that has to end at an explanation, and treating it as an ordinary launch
 * would start another one, which is the loop.
 *
 * Deliberately not a partial parse: what it means is "somebody should read this
 * with {@link readAuthorizationResponse}", and that function owns every judgement
 * about whether the response is usable.
 */
export function carriesAuthorizationResponse(callbackUrl: string): boolean {
  const read = authorizationParameters(callbackUrl);
  if (read === undefined) {
    return false;
  }
  return read('code') !== null || read('error') !== null;
}

/**
 * Reads the authorization response out of the URL the browser was redirected to.
 *
 * Every failure here is a refusal, never a `null` the caller might carry on with:
 * a callback with no code in it is not a login that half worked.
 */
export function readAuthorizationResponse(callbackUrl: string): AuthorizationResponse {
  const read = authorizationParameters(callbackUrl);
  if (read === undefined) {
    throw new MatrixOidcCallbackError(`"${callbackUrl}" is not a URL`);
  }

  const error = read('error');
  if (error !== null) {
    const description = read('error_description');
    throw new MatrixOidcCallbackError(
      description === null
        ? `the authorization server answered "${error}"`
        : `the authorization server answered "${error}": ${description}`,
    );
  }

  const code = read('code');
  const state = read('state');
  if (code === null || state === null) {
    throw new MatrixOidcCallbackError(
      'it carries neither an authorization code and state nor an error',
    );
  }

  return { code, state };
}

/**
 * A random `state` for one authorization.
 *
 * Its only job is to be unguessable and to come back unchanged, which is what
 * ties a callback to the request that started it.
 */
export function generateAuthorizationState(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class WebOidcLoginRequest implements AlloOidcLoginRequest {
  readonly #authorization: OidcAuthorization;
  readonly #state: string;
  readonly #onGrant: OidcGrantHandler;
  readonly authorizationUrl: string;

  #settled = false;

  constructor(
    authorization: OidcAuthorization,
    authorizationUrl: string,
    state: string,
    onGrant: OidcGrantHandler,
  ) {
    this.#authorization = authorization;
    this.#state = state;
    this.#onGrant = onGrant;
    this.authorizationUrl = authorizationUrl;
  }

  async complete(callbackUrl: string): Promise<AlloSession> {
    this.#settle('complete');

    const response = readAuthorizationResponse(callbackUrl);
    if (response.state !== this.#state) {
      // Either a callback from an authorization this request did not start — the
      // shape a cross-site request forgery arrives in — or a stale redirect from
      // an earlier attempt. Neither is this login.
      throw new MatrixOidcCallbackError('its state is not the one this login sent');
    }

    const tokens = await this.#authorization.completeAuthorizationCodeGrant(response.code);
    return this.#onGrant({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      deviceId: this.#authorization.context.deviceId,
    });
  }

  async abort(): Promise<void> {
    // Nothing to release, and that is not an oversight: where the native binding
    // holds server-side state for an attempt and needs `abortOidcAuth` to let it
    // go, an authorization that was never completed leaves nothing behind on web
    // beyond the code verifier this object is holding. What abort still does is
    // close the request, so a redirect that arrives afterwards is refused rather
    // than finishing a login the user walked away from.
    this.#settle('abort');
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
