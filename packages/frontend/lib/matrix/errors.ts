/**
 * Errors the chat port raises on its own account.
 *
 * Failures that come from the homeserver or the SDK are passed through
 * untouched: wrapping them would throw away the diagnostic the caller needs
 * (uniffi carries `code`, `msg` and `details` on the error's `inner`, not on
 * `message`). What is here are the states the port itself refuses to be in.
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
