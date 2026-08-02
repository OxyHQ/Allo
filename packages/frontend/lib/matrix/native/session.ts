import type { ClientSessionDelegate, Session } from '@unomed/react-native-matrix-sdk';

import { MatrixNotLoggedInError, MatrixSessionRestoreError } from '@/lib/matrix/errors';
import type { AlloSession, AlloUnsubscribe } from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

/**
 * The session: translated, and watched for the moment the SDK replaces it.
 *
 * Its own module rather than part of `translate.ts` because none of it needs the
 * SDK at runtime — only the shape of its `Session` record and the shape of the
 * delegate it calls back on, both of which are types and disappear at compile
 * time. Keeping it apart is what lets the authentication path, which depends on
 * this and on nothing else of the binding's, be exercised without loading the
 * native module.
 */

const LOG_TAG = '[matrix]';

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

/** What the delegate needs of the client it belongs to. */
export interface SessionReader {
  session(): Session;
}

/**
 * How the app finds out that the SDK has replaced the session.
 *
 * This is the binding's only answer to that question, and it is not shaped like
 * an observer: it is a *delegate*, handed to the builder before the client
 * exists, and the SDK calls it "keychain" because it expects the app to keep the
 * session where a phone keeps secrets. Allo does — see
 * `lib/chat/matrixSessionStorage.ts` — but not from here: this object turns two
 * synchronous callbacks into the port's `observeSession`, and where the bytes go
 * is a decision the app gets to make once, above the platform split.
 *
 * Why it matters at all: under OIDC the access token is short-lived and the SDK
 * refreshes it on its own. A session written down at login and never updated is
 * correct for minutes and then permanently stale, which is a session that looks
 * persisted and silently stops restoring — and every launch that fails to restore
 * is a new Matrix device on the user's account.
 *
 * **Callbacks come from Rust, on Rust's thread, and are synchronous.** Nothing
 * here may block, and nothing here may throw where the SDK did not ask a
 * question: a listener that fails must not become a token refresh that fails.
 */
export class NativeSessionDelegate implements ClientSessionDelegate {
  readonly #listeners = new Set<(session: AlloSession) => void>();

  #reader: SessionReader | undefined;

  /**
   * Points the delegate at the client it was built with.
   *
   * Two-phase because the order is forced: `ClientBuilder.setSessionDelegate`
   * takes the delegate, and only then is there a client for it to read.
   */
  bind(reader: SessionReader): void {
    this.#reader = reader;
  }

  /** Reports every session the SDK saves from now on. */
  observe(onChange: (session: AlloSession) => void): AlloUnsubscribe {
    this.#listeners.add(onChange);
    return () => {
      this.#listeners.delete(onChange);
    };
  }

  /**
   * The session as the SDK last left it.
   *
   * Answered from the client rather than from storage, which is not what the name
   * suggests and is the right thing here. The call exists for a second process —
   * a notification extension — that may have refreshed the tokens while this one
   * slept, and Allo has no such process: it does not enable the SDK's
   * cross-process refresh lock, so the only party that ever changes this
   * session is the client being asked. Reading a copy out of the keychain would
   * risk answering with something older than what the client already has.
   */
  retrieveSessionFromKeychain(userId: string): Session {
    if (this.#reader === undefined) {
      throw new MatrixNotLoggedInError('Reading the session the SDK asked for');
    }
    const session = this.#reader.session();
    if (session.userId !== userId) {
      // The client holds one user's session; being asked for another one means
      // the SDK and this delegate disagree about which client this is.
      throw new MatrixSessionRestoreError(
        `the SDK asked for ${userId}'s session and this client holds ${session.userId}'s`,
      );
    }
    return session;
  }

  /** The SDK has new tokens. Everything downstream of here is a persist. */
  saveSessionInKeychain(session: Session): void {
    const translated = toAlloSession(session);
    for (const listener of this.#listeners) {
      try {
        listener(translated);
      } catch (error) {
        // Never the session itself: it is a credential. A listener that failed
        // means this rotation was not written down, so the next launch restores
        // the previous one and the SDK refreshes again — recoverable, and worth
        // saying out loud.
        logger.error(`${LOG_TAG} a refreshed session could not be handled`, error);
      }
    }
  }
}
