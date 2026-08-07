/**
 * The middle step of OIDC, which is the one that differs most between a browser
 * and a phone.
 *
 * The app asks the port for a URL, hands it to a browser it does not control, and
 * comes back with whatever that browser was redirected to. On iOS and Android
 * "hands it to a browser" is an in-app tab that returns control to the running
 * app; on web it is the tab the app is *in*, which means the app does not come
 * back at all — it is destroyed and a fresh copy is loaded at the redirect URI.
 *
 * That difference is why this is a contract with two implementations
 * (`matrixAuthorizer.native.ts` and `matrixAuthorizer.web.ts`) rather than one
 * function with a branch, and why {@link AuthorizationOutcome} has a case for
 * leaving. A promise that never resolved because the page was about to go away
 * would leave the runtime's state machine claiming to be waiting for something
 * that can no longer happen.
 *
 * Why web cannot use the in-app-browser call: `expo-web-browser` implements
 * `openAuthSessionAsync` there as `window.open`, and a popup opened without a
 * user gesture behind it is blocked by every browser. Allo starts this sign-in
 * automatically — there is an Oxy session to inherit and asking a signed-in
 * person to sign in again is the thing that is being removed — so there is no
 * gesture, and the popup was blocked every single time.
 */

/** What the browser came back with, if it came back. */
export type AuthorizationOutcome =
  /** The browser was redirected back to the app, with this URL. */
  | { readonly kind: 'returned'; readonly callbackUrl: string }
  /** The user closed the browser without finishing. */
  | { readonly kind: 'dismissed' }
  /**
   * The page is being replaced by the authorization server's.
   *
   * Nothing further will happen in this copy of the app. What finishes the login
   * is the next launch, at the redirect URI, through
   * {@link MatrixPendingAuthorization}.
   */
  | { readonly kind: 'left' };

/**
 * Opens the authorization page and reports what happened.
 *
 * The URL is passed as it was built by the port and must not be modified: it
 * carries the PKCE challenge and the `state` the callback is checked against.
 */
export type MatrixAuthorizer = (
  authorizationUrl: string,
  redirectUri: string,
) => Promise<AuthorizationOutcome>;

/**
 * The authorization response this launch of the app arrived with, if it arrived
 * with one.
 *
 * Only web ever answers with anything. Reading and removing are one step on
 * purpose — see {@link take}.
 */
export interface MatrixPendingAuthorization {
  /**
   * The URL the authorization server sent the browser back to, and removes the
   * response from the address bar.
   *
   * One step, because the two must not come apart. The authorization code in
   * that URL is spent by the exchange whether or not the exchange succeeds, so a
   * reload that still carried it would ask the server to accept a code it has
   * already seen — and the app would report a failed sign-in for a code that
   * worked the first time.
   */
  take(): string | undefined;
}
