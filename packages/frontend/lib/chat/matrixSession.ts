import type { AlloSession } from '@/lib/matrix/types';

/**
 * The session as it is written down between launches.
 *
 * A record and not the bare {@link AlloSession} for two reasons, both of which
 * are about reading something back that was written by a different Allo than the
 * one reading it:
 *
 * - **a version**, so a shape that changes is refused rather than guessed at. The
 *   cost of refusing is one sign-in; the cost of guessing is a client that
 *   believes it has a session and cannot use it.
 * - **the homeserver**, checked against the one this build talks to. A build
 *   pointed at a different homeserver has a session for a server that never
 *   issued it, and the device it names does not exist there.
 *
 * Nothing here parses `authData`: the port defines it as opaque and only the
 * implementation that wrote it can read it. What this module checks is that it is
 * a string, which is all it is allowed to know.
 *
 * **Everything this module returns is a credential.** The tokens must never reach
 * a log, a crash report, or Allo's own backend; the reasons it gives for refusing
 * a record are written so that they name what is wrong without quoting any of it.
 */

/**
 * Bumped when {@link StoredSession} changes shape.
 *
 * Adding a field that older Allos will not have written is a version bump too: a
 * record missing something the client needs restores into a session that cannot
 * refresh itself, which is the failure this whole module exists to avoid.
 */
export const STORED_SESSION_VERSION = 1;

interface StoredSession {
  readonly version: typeof STORED_SESSION_VERSION;
  readonly session: AlloSession;
}

/** What was found where the session is kept. */
export type StoredSessionOutcome =
  /** A session that can be restored. */
  | { readonly kind: 'session'; readonly session: AlloSession }
  /** Nothing was stored. The ordinary state of a fresh install. */
  | { readonly kind: 'absent' }
  /**
   * Something was stored and cannot be used. Distinct from `absent` because the
   * two are not the same event: this one is worth a log line, and it means a
   * device's keys are being abandoned rather than never having existed.
   */
  | { readonly kind: 'unusable'; readonly reason: string };

export function encodeStoredSession(session: AlloSession): string {
  const record: StoredSession = { version: STORED_SESSION_VERSION, session };
  return JSON.stringify(record);
}

/**
 * Reads back what {@link encodeStoredSession} wrote, for the homeserver this
 * build talks to.
 *
 * Every check is a refusal rather than a repair. A half-valid session is not a
 * session that half works: it is one the SDK accepts and then cannot renew, and
 * the user meets that as messages that stop arriving rather than as a sign-in
 * screen.
 */
export function decodeStoredSession(
  raw: string | undefined,
  homeserverUrl: string,
): StoredSessionOutcome {
  if (raw === undefined || raw === '') {
    return { kind: 'absent' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unusable', reason: 'what was stored is not JSON' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'unusable', reason: 'what was stored is not an object' };
  }

  const record: Record<string, unknown> = { ...parsed };
  if (record.version !== STORED_SESSION_VERSION) {
    return {
      kind: 'unusable',
      reason:
        `it is version ${String(record.version)}, and this Allo writes ` +
        `version ${STORED_SESSION_VERSION}`,
    };
  }

  const session = readSession(record.session);
  if (typeof session === 'string') {
    return { kind: 'unusable', reason: session };
  }

  if (session.homeserverUrl !== homeserverUrl) {
    // Not a corrupt record: a build that was pointed somewhere else. Restoring
    // it would hand this homeserver a device id it never issued.
    return {
      kind: 'unusable',
      reason:
        `it belongs to ${session.homeserverUrl} and this build talks to ` +
        homeserverUrl,
    };
  }

  return { kind: 'session', session };
}

/** The session, or a sentence saying what is missing from it. */
function readSession(value: unknown): AlloSession | string {
  if (typeof value !== 'object' || value === null) {
    return 'it carries no session';
  }

  const fields: Record<string, unknown> = { ...value };
  const userId = readRequired(fields.userId);
  const deviceId = readRequired(fields.deviceId);
  const homeserverUrl = readRequired(fields.homeserverUrl);
  const accessToken = readRequired(fields.accessToken);
  const refreshToken = readOptional(fields.refreshToken);
  const authData = readOptional(fields.authData);

  if (userId === undefined) {
    return 'it names no user';
  }
  if (deviceId === undefined) {
    // The device id is the installation's identity and what its encryption keys
    // hang off. A session without one cannot be the same device twice.
    return 'it names no device';
  }
  if (homeserverUrl === undefined) {
    return 'it names no homeserver';
  }
  if (accessToken === undefined) {
    return 'it carries no access token';
  }
  if (refreshToken === null) {
    return 'its refresh token is not a string';
  }
  if (authData === null) {
    return 'its authentication data is not a string';
  }

  return { userId, deviceId, homeserverUrl, accessToken, refreshToken, authData };
}

/** A non-empty string, or `undefined` if it is anything else. */
function readRequired(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * A string or nothing, or `null` for a value that is neither.
 *
 * The three-way answer is what separates "this session has no refresh token",
 * which is a homeserver that does not issue them, from "this record is damaged".
 */
function readOptional(value: unknown): string | undefined | null {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === 'string' ? value : null;
}
