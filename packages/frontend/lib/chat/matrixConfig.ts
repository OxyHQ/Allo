import { Platform } from 'react-native';
import * as Linking from 'expo-linking';

import { resolveAlloChatStore } from '@/lib/matrix/store';
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
 * The path the browser is sent back to on web: the app itself.
 *
 * It used to be a static file in `public/`, because the authorization ran in a
 * popup and the web export answers unknown paths with `index.html` — so a
 * redirect at an app route would have booted a second copy of Allo *inside the
 * popup*, and two `MatrixClient`s on one IndexedDB corrupts the crypto store
 * (`lib/matrix/client.web.ts`, the note at the top).
 *
 * There is no popup any more. The authorization is a top-level navigation
 * (`matrixAuthorizer.web.ts`), which replaces this page rather than adding one,
 * so there is never a second copy of Allo and the app can be its own redirect
 * target — which it has to be, because the login is finished by the app on the
 * way back in and a static file cannot do that.
 *
 * The root and not a route of its own: a dedicated `/matrix-oidc-callback` route
 * would still be answered by `index.html`, so it would be the same app under a
 * name that suggests otherwise, and it would need registering with the
 * authorization server all the same.
 */
const WEB_CALLBACK_PATH = '/';

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
 * The store is on disk, which is what makes an installation one Matrix device
 * rather than one per launch. It only became worth having once the session
 * survived too: a device's encryption keys are useless without the session that
 * names the device, so before sessions were persisted a store on disk would have
 * accumulated the keys of devices nothing would ever use again. Where "on disk"
 * is — two directories, or an IndexedDB database — is `lib/matrix/store.*.ts`'s
 * to decide, because it is the one thing here that is not the same question on
 * both platforms.
 */
export function readMatrixClientConfig(): AlloChatClientConfig {
  const homeserverUrl = readHomeserverUrl(process.env.EXPO_PUBLIC_MATRIX_HOMESERVER);
  const redirectUri = resolveRedirectUri(process.env.EXPO_PUBLIC_MATRIX_OIDC_REDIRECT_URI);
  return {
    homeserverUrl,
    store: resolveAlloChatStore(),
    oidc: readOidcMetadata(
      homeserverUrl,
      process.env.EXPO_PUBLIC_MATRIX_OIDC_CLIENT_ID,
      redirectUri,
    ),
  };
}
