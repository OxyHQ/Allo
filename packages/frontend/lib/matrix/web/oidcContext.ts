import { MatrixOidcContextUnavailableError } from '@/lib/matrix/errors';
import { logger } from '@/utils/logger';

/**
 * What an authorization needs to survive the page that started it.
 *
 * On web the authorization is a top-level navigation: the browser leaves Allo,
 * goes to the authorization server, and comes back to a fresh load of the app.
 * Everything held in memory by the page that started the login — the `OAuth2`
 * object, the PKCE code verifier it minted, the `state` it sent — is gone by
 * then, and none of it can be rebuilt from the callback URL. So it is written
 * down before the navigation and read back on the way in.
 *
 * `sessionStorage` and not `localStorage`. It is scoped to the one tab that is
 * making the trip, it survives the trip, and it dies with the tab — where
 * `localStorage` would leave a code verifier behind for every future tab of the
 * same browser, long after the authorization it belongs to expired.
 *
 * **One slot, not one per `state`.** The SDK's own advice is to key the storage
 * by the `state` it generates, which would allow several authorizations in
 * flight at once; on web there cannot be, because starting one replaces the page
 * that any other was running in. A single slot holding the `state` it was
 * written with is the same guarantee with a smaller surface: the callback's
 * `state` is compared against the one record there is, so a response can only
 * finish the most recent request this tab sent.
 */

/** The one key. Namespaced so it cannot collide with anything else on the origin. */
export const PENDING_LOGIN_KEY = 'allo.matrix.oidc.pending';

/**
 * Bumped when the shape changes. An older record is refused rather than guessed
 * at, the same way `AlloSession.authData` is: the cost is one login, and the
 * alternative is an exchange built out of half a context.
 */
const PENDING_LOGIN_VERSION = 1;

/**
 * A login that left the page, as it has to be written down to be picked up.
 *
 * Everything here except `state` is `matrix-js-sdk`'s `OAuth2` context — the
 * shape its own documentation calls "the persistent context needed for typical
 * OAuth flows" — plus the two things needed to know the record is still the
 * right one to use.
 */
export interface PendingWebLogin {
  /**
   * The opaque value sent to the authorization server, which has to come back
   * unchanged.
   *
   * Stored because it is the whole of what ties a callback to the request that
   * started it, and the request object that generated it did not survive.
   */
  readonly state: string;
  /**
   * The URL the browser was sent to.
   *
   * Kept so that a request rebuilt from this record can say which authorization
   * it belongs to, rather than carrying an empty string where the port's type
   * promises a URL. Nothing opens it again: it is spent.
   */
  readonly authorizationUrl: string;
  /** The OAuth client id this authorization was started as. */
  readonly clientId: string;
  /** The device id carried in the requested scope. */
  readonly deviceId: string;
  /**
   * The PKCE code verifier.
   *
   * A one-time secret, and the reason this record is worth keeping small and
   * short-lived: with it and an intercepted authorization code, an attacker
   * could complete the exchange. It never leaves this origin's `sessionStorage`,
   * is removed the moment the login is picked up, and is never logged.
   */
  readonly codeVerifier: string;
  /** The redirect URI the code was issued against; the exchange must repeat it. */
  readonly redirectUri: string;
  /**
   * The homeserver the login was started against.
   *
   * A build repointed at another homeserver between leaving and coming back —
   * a deploy, in practice — must not exchange this code against the new one.
   */
  readonly homeserverUrl: string;
  /**
   * The authorization server metadata as discovered.
   *
   * `unknown` on purpose, exactly as `WebAuthData.authMetadata` is: this module
   * has no runtime dependency on the SDK and will not half-validate a structure
   * the SDK validates properly. The caller runs it through `isValidAuthMetadata`.
   */
  readonly authMetadata: unknown;
}

/**
 * Where a login waits out the navigation.
 *
 * An interface because `client.web.ts` takes it as a dependency: the whole
 * leave-and-return path is then exercisable without a browser.
 */
export interface PendingWebLoginStore {
  /** Writes the record, replacing whatever was there. Throws if it cannot. */
  write(login: PendingWebLogin): void;
  /**
   * Reads the record and removes it, in one step.
   *
   * Removing is not optional and not the caller's to postpone. The record exists
   * to be used exactly once: the authorization code that arrives with it is
   * spent by the exchange whether or not the exchange succeeds, so a record left
   * behind is one that can only ever produce a second, failing attempt.
   */
  take(): PendingWebLogin | undefined;
}

/** `sessionStorage`, which is the only place this can be. */
export const sessionPendingWebLoginStore: PendingWebLoginStore = {
  write: (login) => {
    requireSessionStorage('write down a sign-in that leaves this page').setItem(
      PENDING_LOGIN_KEY,
      JSON.stringify({ version: PENDING_LOGIN_VERSION, ...login }),
    );
  },
  take: () => {
    const storage = requireSessionStorage('pick up a sign-in that left this page');
    const raw = storage.getItem(PENDING_LOGIN_KEY);
    storage.removeItem(PENDING_LOGIN_KEY);
    if (raw === null) {
      return undefined;
    }
    return decodePendingWebLogin(raw);
  },
};

function requireSessionStorage(operation: string): Storage {
  const storage: Storage | undefined = globalThis.sessionStorage;
  if (storage === undefined) {
    throw new MatrixOidcContextUnavailableError(
      `it cannot ${operation} because this browser exposes no sessionStorage`,
    );
  }
  return storage;
}

/**
 * Reads back what was written, or reports that there is nothing usable.
 *
 * Every failure answers `undefined` rather than throwing, and the reason is the
 * caller: a record that cannot be read is a login that cannot be finished, which
 * is the same situation as no record at all and has the same ending — the app
 * offers to sign in again. A throw here would instead turn a leftover from an
 * older version of Allo into an error screen.
 *
 * It is logged, without the record: what is in it is a credential.
 */
export function decodePendingWebLogin(raw: string): PendingWebLogin | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('[matrix] a stored sign-in was discarded: it is not JSON');
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    logger.warn('[matrix] a stored sign-in was discarded: it is not an object');
    return undefined;
  }

  const fields: Record<string, unknown> = { ...parsed };
  if (fields.version !== PENDING_LOGIN_VERSION) {
    logger.warn(
      `[matrix] a stored sign-in was discarded: it is version ${String(fields.version)}, ` +
        `not ${PENDING_LOGIN_VERSION}`,
    );
    return undefined;
  }

  const state = readString(fields, 'state');
  const authorizationUrl = readString(fields, 'authorizationUrl');
  const clientId = readString(fields, 'clientId');
  const deviceId = readString(fields, 'deviceId');
  const codeVerifier = readString(fields, 'codeVerifier');
  const redirectUri = readString(fields, 'redirectUri');
  const homeserverUrl = readString(fields, 'homeserverUrl');
  if (
    state === undefined ||
    authorizationUrl === undefined ||
    clientId === undefined ||
    deviceId === undefined ||
    codeVerifier === undefined ||
    redirectUri === undefined ||
    homeserverUrl === undefined
  ) {
    return undefined;
  }

  const { authMetadata } = fields;
  if (typeof authMetadata !== 'object' || authMetadata === null) {
    logger.warn(
      '[matrix] a stored sign-in was discarded: it carries no authorization server metadata',
    );
    return undefined;
  }

  return {
    state,
    authorizationUrl,
    clientId,
    deviceId,
    codeVerifier,
    redirectUri,
    homeserverUrl,
    authMetadata,
  };
}

/** One non-empty string field, or `undefined` and a line saying which was missing. */
function readString(fields: Record<string, unknown>, name: string): string | undefined {
  const value = fields[name];
  if (typeof value !== 'string' || value === '') {
    logger.warn(`[matrix] a stored sign-in was discarded: it has no ${name}`);
    return undefined;
  }
  return value;
}
