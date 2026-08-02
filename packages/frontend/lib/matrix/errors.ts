/**
 * Errors the chat port raises on its own account.
 *
 * Failures that come from the homeserver or the SDK are passed through
 * untouched: wrapping them would throw away the diagnostic the caller needs —
 * uniffi carries `code`, `msg` and `details` on the error's `inner` rather than
 * on `message`, and `matrix-js-sdk` carries `errcode` and `httpStatus` on its
 * `MatrixError`. What is here are the states the port itself refuses to be in.
 */

/** Base class, so a caller can tell "the port said no" from "the network said no". */
export class MatrixPortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * Thrown by the web implementation, which does not exist yet.
 *
 * It throws rather than returning a stub because a stub that silently does
 * nothing is how a platform ends up shipping with its messaging quietly broken.
 */
export class MatrixPlatformUnsupportedError extends MatrixPortError {
  constructor(platform: string, reason: string) {
    super(`The Matrix chat port has no implementation for ${platform}: ${reason}`);
  }
}

/** An operation that reads sync state was attempted before sync was started. */
export class MatrixSyncNotStartedError extends MatrixPortError {
  constructor(operation: string) {
    super(
      `${operation} needs the sync loop running. Call startSync() first: it is ` +
        'what populates the room list and the timelines.',
    );
  }
}

/**
 * An authorization that has already been completed or abandoned was used again.
 *
 * Worth its own type because the two ways it happens are ordinary: a redirect
 * that fires twice, and a user who closes the browser on an attempt the app then
 * tries to finish.
 */
export class MatrixOidcLoginSettledError extends MatrixPortError {
  constructor(attempted: string) {
    super(
      `Cannot ${attempted} an OIDC login that has already been completed or ` +
        'aborted. Start a new one with beginOidcLogin().',
    );
  }
}

/**
 * A room id the client does not know.
 *
 * Distinct from "the room does not exist": a room the viewer has been invited to
 * is only known once sync has delivered it, so this is also what a caller sees
 * when it asks too early.
 */
export class MatrixRoomNotFoundError extends MatrixPortError {
  constructor(roomId: string) {
    super(`The client has no room ${roomId}. It may not have been synced yet.`);
  }
}

/** Something that needs a session was attempted before there was one. */
export class MatrixNotLoggedInError extends MatrixPortError {
  constructor(operation: string) {
    super(
      `${operation} needs a session. Finish a login with beginOidcLogin(), or ` +
        'reinstate one with restoreSession().',
    );
  }
}

/**
 * A second session was started on a client that already has one.
 *
 * Worth refusing rather than allowing: a client holds one device's encryption
 * store, and pointing it at a second device would either take over the first
 * device's identity or abandon the keys that decrypt its history.
 */
export class MatrixSessionAlreadyStartedError extends MatrixPortError {
  constructor(attempted: string) {
    super(
      `Cannot ${attempted}: this client already has a session. Build a new ` +
        'client for a different one.',
    );
  }
}

/**
 * The URL the browser came back to did not carry a usable authorization.
 *
 * Covers the authorization server saying no, a callback with nothing in it, and
 * — the one that matters for security — a `state` that is not the one this
 * request sent, which is how an authorization from somewhere else would arrive.
 */
export class MatrixOidcCallbackError extends MatrixPortError {
  constructor(reason: string) {
    super(`The OIDC callback cannot be completed: ${reason}`);
  }
}

/**
 * A persisted session could not be read back.
 *
 * `AlloSession.authData` is written by one implementation and only that
 * implementation can read it; the usual cause is a session stored by the native
 * client being handed to the web one, or the reverse.
 */
export class MatrixSessionRestoreError extends MatrixPortError {
  constructor(reason: string) {
    super(`This session cannot be restored: ${reason}. Start a new login.`);
  }
}

/**
 * The browser does not offer the storage the client needs.
 *
 * Not a hypothetical: private browsing modes and embedded webviews can refuse
 * IndexedDB, and without it there is nowhere to keep the device's encryption
 * keys — which means a device that cannot read any of its own history.
 */
export class MatrixStoreUnavailableError extends MatrixPortError {
  constructor(detail: string) {
    super(`The Matrix client has nowhere to keep its data: ${detail}`);
  }
}
