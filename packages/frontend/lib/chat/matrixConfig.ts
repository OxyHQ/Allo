import { Platform } from 'react-native';
import * as Linking from 'expo-linking';

import type { AlloChatClientConfig, AlloOidcClientMetadata } from '@/lib/matrix/types';

/**
 * What a build needs to know to talk to a homeserver.
 *
 * Read once, here, and nowhere else. Everything is an environment variable
 * because a homeserver is a deployment decision: the development one is
 * `matrix.org`, Allo's own does not exist yet, and neither belongs in the source.
 */

/** Where the homeserver is. No default: see {@link readHomeserverUrl}. */
export const HOMESERVER_VARIABLE = 'EXPO_PUBLIC_MATRIX_HOMESERVER';

/** A client id agreed with the authorization server in advance, if there is one. */
export const OIDC_CLIENT_ID_VARIABLE = 'EXPO_PUBLIC_MATRIX_OIDC_CLIENT_ID';

/** Where the authorization server sends the user back. */
export const OIDC_REDIRECT_URI_VARIABLE = 'EXPO_PUBLIC_MATRIX_OIDC_REDIRECT_URI';

const CLIENT_NAME = 'Allo';
const CLIENT_URI = 'https://allo.you';

/**
 * The path the browser is sent back to on web.
 *
 * A static file in `public/`, deliberately not a route of the app. The web export
 * serves `index.html` for unknown paths, so a redirect at an app route would boot
 * a second copy of Allo in the popup — and a second copy means a second
 * `MatrixClient` on one IndexedDB, which the SDK says corrupts the crypto store
 * (`lib/matrix/client.web.ts`, the note at the top). A page that is not the app
 * cannot do that.
 */
const WEB_CALLBACK_PATH = '/matrix-oidc-callback.html';

/** The deep link the browser is sent back to on iOS and Android. */
const NATIVE_CALLBACK_PATH = 'matrix/oidc';

/**
 * The homeserver, or an explanation of what is missing.
 *
 * There is no fallback on purpose. A default would have to be either Allo's
 * production homeserver — which does not exist — or someone else's, and a build
 * that quietly talks to a homeserver nobody chose is worse than one that will not
 * start.
 */
export function readHomeserverUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') {
    throw new Error(
      `The Matrix chat backend is enabled but ${HOMESERVER_VARIABLE} is not set, ` +
        'so there is no homeserver to talk to. Set it to the homeserver this ' +
        'build should use — https://matrix.org while Allo has none of its own.',
    );
  }
  return raw;
}

/**
 * Where the authorization server sends the user back.
 *
 * Overridable because a deployment may have registered a different one with the
 * authorization server, and a redirect URI that does not match the registration
 * is rejected by the server rather than by us.
 */
export function resolveRedirectUri(configured: string | undefined): string {
  if (configured !== undefined && configured !== '') {
    return configured;
  }
  if (Platform.OS === 'web') {
    return new URL(WEB_CALLBACK_PATH, globalThis.location.origin).toString();
  }
  return Linking.createURL(NATIVE_CALLBACK_PATH);
}

export function readOidcMetadata(
  homeserverUrl: string,
  clientId: string | undefined,
  redirectUri: string,
): AlloOidcClientMetadata {
  return {
    clientName: CLIENT_NAME,
    clientUri: CLIENT_URI,
    redirectUri,
    // Keyed by homeserver rather than by issuer: the issuer is only known after
    // the client has asked the homeserver for its authorization metadata, and the
    // port accepts either key.
    staticRegistrations:
      clientId === undefined || clientId === ''
        ? undefined
        : new Map([[homeserverUrl, clientId]]),
  };
}

/**
 * The configuration the port is built with.
 *
 * The store is in memory, and that is a decision rather than an oversight. A
 * filesystem store keeps a device's encryption keys across launches, which is
 * only worth anything if the *session* survives too — and it does not: the port
 * documents that a persisted session goes stale, because the SDK rotates its
 * tokens without telling the app (`lib/matrix/types.ts`, `AlloSession`). Until
 * that gap is closed, every launch is a new login and therefore a new Matrix
 * device, and a crypto store on disk would only accumulate the keys of devices
 * nothing will ever use again.
 */
export function readMatrixClientConfig(): AlloChatClientConfig {
  const homeserverUrl = readHomeserverUrl(process.env.EXPO_PUBLIC_MATRIX_HOMESERVER);
  const redirectUri = resolveRedirectUri(process.env.EXPO_PUBLIC_MATRIX_OIDC_REDIRECT_URI);
  return {
    homeserverUrl,
    store: { kind: 'in-memory' },
    oidc: readOidcMetadata(
      homeserverUrl,
      process.env.EXPO_PUBLIC_MATRIX_OIDC_CLIENT_ID,
      redirectUri,
    ),
  };
}
