import * as WebBrowser from 'expo-web-browser';

import type {
  AuthorizationOutcome,
  MatrixAuthorizer,
  MatrixPendingAuthorization,
} from '@/lib/chat/matrixAuthorization';

/**
 * The authorization step on iOS and Android.
 *
 * `openAuthSessionAsync` is an in-app browser tab — `SFAuthenticationSession` on
 * iOS, a Custom Tab on Android — which is the right thing here and not a
 * compromise: it shares no cookies with the app, it shows the user which origin
 * they are typing their password into, and it hands control back to this same
 * running process. There is no popup blocker in front of it, so it does not need
 * a user gesture, and the app is still here when it resolves.
 *
 * The web half of this file is the one that had to change. See
 * `matrixAuthorizer.web.ts`.
 */

export const authorize: MatrixAuthorizer = async (
  authorizationUrl,
  redirectUri,
): Promise<AuthorizationOutcome> => {
  const result = await WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri);
  return result.type === 'success'
    ? { kind: 'returned', callbackUrl: result.url }
    : { kind: 'dismissed' };
};

/**
 * Nothing, always.
 *
 * A launch of the app on a phone is never the second half of a login: the
 * browser above returns to the process that opened it, so the login is finished
 * before anything could be picked up. Answering `undefined` is what makes the
 * runtime's boot path platform-independent — it asks on every platform and only
 * web ever has anything to say.
 */
export const pendingAuthorization: MatrixPendingAuthorization = {
  take: () => undefined,
};
