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

/**
 * A message operation was asked for on an event the homeserver has not accepted.
 *
 * Reactions, edits, redactions and read receipts all address an event by its id,
 * and a message still on its way out has none — it is addressable only by the
 * transaction id its own timeline minted for it. The Rust binding can address
 * some of those anyway and `matrix-js-sdk` cannot, so rather than let the two
 * platforms disagree about which taps do nothing, both refuse with this.
 */
export class MatrixEventNotSentError extends MatrixPortError {
  constructor(operation: string, key: string) {
    super(
      `${operation} needs an event id, and the message ${key} has not been ` +
        'accepted by the homeserver yet. Wait for it to be sent.',
    );
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

/**
 * A recovery phrase that is not a BIP-39 mnemonic.
 *
 * The message names no words and quotes nothing back: the phrase is the whole
 * Oxy identity, and an error string is the one place a credential most easily
 * escapes into a log.
 */
export class MatrixRecoveryPhraseInvalidError extends MatrixPortError {
  constructor() {
    super(
      'That is not a valid Oxy recovery phrase, so no key can be derived from ' +
        'it. Check the words rather than the message history.',
    );
  }
}

/**
 * The crypto machine was asked for before it existed.
 *
 * On web the SDK's `getCrypto()` answers `undefined` until the WebAssembly has
 * been loaded and initialised, which the port does while a session starts. A
 * caller seeing this has asked before there was a session.
 */
export class MatrixCryptoUnavailableError extends MatrixPortError {
  constructor(operation: string) {
    super(
      `${operation} needs the encryption stack, which is only brought up once ` +
        'there is a session. Finish a login or restore a session first.',
    );
  }
}

/**
 * Recovery was asked to create a key backup while the server already holds one
 * this device cannot use.
 *
 * Refused rather than resolved, because both ways of resolving it lose
 * something: creating a new backup version orphans every room key that only the
 * old version holds, and adopting the old one needs a key this device does not
 * have. The native SDK refuses the same case with `BackupExistsOnServer`; this
 * is the web half saying the same thing rather than quietly resetting.
 */
export class MatrixBackupExistsOnServerError extends MatrixPortError {
  constructor() {
    super(
      'The homeserver already holds a key backup that this device has not ' +
        'enabled. Creating a new one would abandon the keys in it, so recovery ' +
        'stops here: open the existing backup with the recovery passphrase ' +
        'instead.',
    );
  }
}

/**
 * The homeserver described its secret storage key in a way the client will not
 * act on.
 *
 * Everything in `m.secret_storage.key.*` comes from the server, so it is
 * external input and is treated as such. A hostile or broken homeserver cannot
 * steal the passphrase — it never sees it — but it can publish a description
 * that makes the client derive a useless key or spend an unbounded amount of
 * time trying. Refusing loudly is the only outcome that is not one of those.
 */
export class MatrixSecretStorageKeyUnusableError extends MatrixPortError {
  constructor(keyId: string, reason: string) {
    super(
      `The secret storage key ${keyId} published by the homeserver cannot be ` +
        `used: ${reason}`,
    );
  }
}
