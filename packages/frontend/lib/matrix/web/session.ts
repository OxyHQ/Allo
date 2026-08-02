import { MatrixSessionRestoreError } from '@/lib/matrix/errors';

/**
 * What the web implementation cannot restore a session without.
 *
 * This is the payload behind `AlloSession.authData`, which the port defines as
 * opaque: the app stores the string and hands it back, and only the
 * implementation that wrote it can read it. That is exactly what this is —
 * nothing here means anything to the native client, and its `authData` means
 * nothing here.
 *
 * What it holds is what refreshing an access token needs. Under OIDC the tokens
 * rotate, and the exchange is between the app and the authorization server rather
 * than the homeserver, so a client with only an access token in hand cannot renew
 * itself: it needs to know which client it registered as, where it registered,
 * and which endpoints to talk to.
 *
 * The authorization server's metadata is kept rather than rediscovered, which
 * buys a restore that needs no network before the sync loop starts. The cost is
 * that a homeserver moving its authorization endpoints invalidates stored
 * sessions — the refresh fails and the user logs in again, which is the same
 * outcome as any other refresh failure and not a state that can be silently
 * wrong.
 */
export interface WebAuthData {
  readonly version: typeof AUTH_DATA_VERSION;
  /** The OAuth client id Allo registered as, dynamically or in advance. */
  readonly clientId: string;
  /** The redirect URI the tokens were issued against; a refresh reuses it. */
  readonly redirectUri: string;
  /**
   * The authorization server metadata as discovered.
   *
   * Deliberately `unknown` here: this module has no runtime dependency on the SDK
   * and will not half-validate a structure the SDK validates properly. The caller
   * runs it through `isValidAuthMetadata` before using it.
   */
  readonly authMetadata: unknown;
}

/**
 * Bumped when the shape changes. An older payload is refused rather than guessed
 * at: the failure is one login, and the alternative is a client that thinks it
 * can refresh a token and cannot.
 */
const AUTH_DATA_VERSION = 1;

export function encodeAuthData(data: Omit<WebAuthData, 'version'>): string {
  return JSON.stringify({ version: AUTH_DATA_VERSION, ...data });
}

/**
 * Reads back what {@link encodeAuthData} wrote.
 *
 * Every failure is a refusal to restore. The likely causes are all real — a
 * session written by the native client, a payload from an older version of Allo,
 * storage that returned something truncated — and none of them is improved by
 * carrying on with half a session.
 */
export function decodeAuthData(raw: string | undefined): WebAuthData {
  if (raw === undefined) {
    throw new MatrixSessionRestoreError('it carries no web authentication data');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MatrixSessionRestoreError('its authentication data is not JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new MatrixSessionRestoreError('its authentication data is not an object');
  }

  const fields: Record<string, unknown> = { ...parsed };
  if (fields.version !== AUTH_DATA_VERSION) {
    throw new MatrixSessionRestoreError(
      `its authentication data is version ${String(fields.version)}, not ${AUTH_DATA_VERSION}`,
    );
  }

  const { clientId, redirectUri, authMetadata } = fields;
  if (typeof clientId !== 'string' || clientId === '') {
    throw new MatrixSessionRestoreError('it names no OAuth client id');
  }
  if (typeof redirectUri !== 'string' || redirectUri === '') {
    throw new MatrixSessionRestoreError('it names no redirect URI');
  }
  if (typeof authMetadata !== 'object' || authMetadata === null) {
    throw new MatrixSessionRestoreError('it carries no authorization server metadata');
  }

  return { version: AUTH_DATA_VERSION, clientId, redirectUri, authMetadata };
}
