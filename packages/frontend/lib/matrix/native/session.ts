import type { Session } from '@unomed/react-native-matrix-sdk';

import type { AlloSession } from '@/lib/matrix/types';

/**
 * The session, translated.
 *
 * Its own module rather than part of `translate.ts` because it is the one
 * translation that needs nothing from the SDK at runtime — only the shape of its
 * `Session` record, which is a type and disappears at compile time. Keeping it
 * apart is what lets the authentication path, which depends on this and on
 * nothing else of the binding's, be exercised without loading the native module.
 */

/** The fields of the SDK's session the port carries. */
export type SessionFields = Pick<
  Session,
  'userId' | 'deviceId' | 'homeserverUrl' | 'accessToken' | 'refreshToken' | 'oidcData'
>;

/**
 * `oidcData` becomes the port's opaque `authData`. Under MAS it is not optional
 * detail: it holds what the SDK needs to refresh the tokens, so a session stored
 * without it restores into a client that cannot renew itself.
 */
export function toAlloSession(session: SessionFields): AlloSession {
  return {
    userId: session.userId,
    deviceId: session.deviceId,
    homeserverUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    authData: session.oidcData,
  };
}
