/**
 * Turning an Oxy user id into the Matrix user id that names the same person.
 *
 * Allo's screens know people by their Oxy id: that is what the profile search
 * answers with, what an avatar is looked up by, and what a report is filed
 * against. A homeserver knows nobody by that name — inviting somebody to a room
 * needs an MXID — so somewhere the two have to be joined, and this is the whole
 * of it.
 *
 * ## Why it is arithmetic and not a lookup
 *
 * `docs/matrix/data-model.md` §6.2 requires the MXID localpart to be derived
 * DETERMINISTICALLY from the Oxy subject in Matrix Authentication Service's
 * configuration, precisely so that the translation is string arithmetic in both
 * directions. The alternative is a table mapping the two, and a table brings
 * every failure a table has: rows that go missing, two ids that map to one, and
 * a user nobody can invite because the row that named them was lost.
 *
 * The backend does the same arithmetic in
 * `packages/backend/src/services/bridges/matrixIdentity.ts`, for the opposite
 * direction. The two are deliberately separate copies rather than one shared
 * module: a frontend cannot import backend source, and `@allo/shared-types`
 * carries type declarations and no runtime code. What keeps them honest is that
 * they encode the same rule from the same paragraph of the same document, and
 * each is tested where it lives.
 *
 * ## Why an unusable id is refused rather than repaired
 *
 * A Matrix localpart admits only `a-z`, `0-9` and `._=-/+`. The tempting repair
 * for an id that does not fit is to lowercase it and drop the rest — and that is
 * how two different people end up with one MXID, which is an invitation sent to
 * the wrong person and, on the backend's side of the same arithmetic, an account
 * takeover. Refusing fails one attempt loudly instead of merging two identities
 * quietly.
 *
 * Allo's Oxy ids are 24-character hexadecimal ObjectIds, which fit unchanged.
 */

/** The grammar of a Matrix localpart Allo is willing to build. */
const LOCALPART_PATTERN = /^[a-z0-9._=/+-]+$/;

/**
 * A Matrix user id is capped at 255 bytes, sigil and server name included.
 *
 * Compared against the string's length rather than its encoded size, and that is
 * exact rather than approximate: everything this module will put in an MXID is
 * ASCII — the localpart by {@link LOCALPART_PATTERN}, and the server name by the
 * grammar Matrix gives it, which is a DNS name, an IP literal and an optional
 * port. One character, one byte.
 */
const MAX_MATRIX_USER_ID_LENGTH = 255;

/** Allo cannot name somebody on the homeserver. */
export class MatrixIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatrixIdentityError';
  }
}

/**
 * The homeserver half of a Matrix user id: what comes after the colon.
 *
 * Read from the signed-in user's own MXID rather than from configuration, and
 * that is the point. `EXPO_PUBLIC_MATRIX_HOMESERVER` is a URL, which is not a
 * server name — `https://matrix-client.matrix.org` serves `matrix.org` — and a
 * second variable holding the name would be one more thing that can disagree
 * with the account this app is actually signed into. The session cannot
 * disagree with itself.
 */
export function matrixServerNameOf(viewerUserId: string): string {
  const separator = viewerUserId.indexOf(':');
  if (!viewerUserId.startsWith('@') || separator < 0) {
    throw new MatrixIdentityError(
      `"${viewerUserId}" is not a Matrix user id, so Allo cannot tell which ` +
        'homeserver the people in this account live on.',
    );
  }
  const serverName = viewerUserId.slice(separator + 1);
  if (serverName === '') {
    throw new MatrixIdentityError(
      `"${viewerUserId}" names no homeserver after its colon.`,
    );
  }
  return serverName;
}

/**
 * The Matrix user id of an Oxy account on this homeserver.
 *
 * Only correct for accounts on the viewer's own homeserver, which is every Allo
 * account: Oxy is the only way to get one. Somebody on another homeserver has an
 * MXID that has nothing to do with any Oxy id, and there is nothing here to
 * derive it from — which is a limit of this function and not a check it skips.
 */
export function matrixUserIdFor(oxyUserId: string, serverName: string): string {
  const localpart = oxyUserId.trim();
  if (localpart === '') {
    throw new MatrixIdentityError('An empty Oxy user id names nobody.');
  }
  if (!LOCALPART_PATTERN.test(localpart)) {
    throw new MatrixIdentityError(
      `The Oxy user id "${localpart}" is not a usable Matrix localpart ` +
        '(allowed: a-z, 0-9 and ._=-/+). It is deliberately not transformed: ' +
        'two ids could be squeezed into one localpart, and that is a message ' +
        'sent to the wrong person.',
    );
  }

  const userId = `@${localpart}:${serverName}`;
  if (userId.length > MAX_MATRIX_USER_ID_LENGTH) {
    throw new MatrixIdentityError(
      `The Matrix user id for "${localpart}" would be longer than ` +
        `${MAX_MATRIX_USER_ID_LENGTH} characters, which no homeserver accepts.`,
    );
  }
  return userId;
}
