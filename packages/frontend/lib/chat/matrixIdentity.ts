/**
 * Turning an Oxy user id into the Matrix user id that names the same person,
 * and back again.
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
 * "In both directions" is the operative half, and for a long time only one of
 * them was here. The consequence was visible: every room on Allo's homeserver
 * has to be named after its members, Matrix Authentication Service publishes no
 * `displayname` for anybody, and so a conversation was titled `@<hex>:allo.you`
 * and a member list was a column of them. {@link oxyUserIdFrom} is the missing
 * half of the argument above.
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
 *
 * **The reverse direction refuses for the mirror reason.** A localpart that is
 * not a well-formed Oxy id must not be trimmed, lowercased or padded into one
 * and then looked up: the lookup would succeed against somebody else, and their
 * name and their face would be drawn over a stranger's messages. A bridge's
 * puppet and a user on another homeserver are exactly that case, and they are
 * routine rather than exceptional — which is why {@link oxyUserIdFrom} answers
 * `undefined` where {@link matrixUserIdFor} throws. See its own note.
 */

/** The grammar of a Matrix localpart Allo is willing to build. */
const LOCALPART_PATTERN = /^[a-z0-9._=/+-]+$/;

/**
 * The grammar of a Matrix localpart Allo is willing to *read*.
 *
 * Wider than {@link LOCALPART_PATTERN}, and deliberately so: that one says what
 * Allo may mint, this one says what a homeserver may hand back. The spec's
 * "historical user ID" grammar is any printable ASCII except `:`, and Allo meets
 * plenty of it — a bridge's `@whatsapp_34600…`, and any account on a homeserver
 * that predates the modern rules. Reading those with the narrow grammar would
 * classify them as "not a Matrix user id at all", and something that is not an
 * id is left on screen verbatim, which is the failure this module is here to
 * stop.
 *
 * `\x21` to `\x7E` is printable ASCII with the space excluded; `\x3A` is the
 * colon, which separates the two halves and so cannot be in either.
 */
const READABLE_LOCALPART_PATTERN = /^[\x21-\x39\x3B-\x7E]+$/;

/**
 * The grammar of the server half: a DNS name, an IPv4 or bracketed IPv6
 * literal, and an optional port.
 *
 * Kept loose on purpose. Nothing here has to *validate* a homeserver — that is
 * the homeserver's own business — it only has to know where a user id stops, so
 * that {@link matrixUserIdsIn} does not swallow the rest of a sentence into one.
 */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9\-.[\]:]+$/;

/**
 * The shape of an Oxy user id: a 24-character hexadecimal MongoDB ObjectId.
 *
 * Lowercase only, because that is what the forward direction produces and what
 * MAS therefore puts in a localpart. Accepting uppercase here would accept an
 * id this app could never have minted, which is the loosening that turns a
 * refusal into a wrong lookup.
 */
const OXY_USER_ID_PATTERN = /^[0-9a-f]{24}$/;

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

/** The two halves of a Matrix user id, once it is known to be one. */
export interface MatrixUserIdParts {
  /** What is between the `@` and the first colon. */
  readonly localpart: string;
  /** Everything after that colon, port included. */
  readonly serverName: string;
}

/**
 * The two halves of a Matrix user id, or `undefined` if it is not one.
 *
 * Split on the FIRST colon and not the last, because the server half may hold a
 * port and an IPv6 literal holds several — `@alba:[::1]:8448` is one user on one
 * server — while the localpart may hold none at all.
 *
 * `undefined` rather than a throw: this is asked about strings that have every
 * right not to be user ids, starting with the title of a room somebody named
 * themselves.
 */
export function parseMatrixUserId(value: string): MatrixUserIdParts | undefined {
  if (!value.startsWith('@') || value.length > MAX_MATRIX_USER_ID_LENGTH) {
    return undefined;
  }
  const separator = value.indexOf(':');
  if (separator < 0) {
    return undefined;
  }
  const localpart = value.slice(1, separator);
  const serverName = value.slice(separator + 1);
  if (!READABLE_LOCALPART_PATTERN.test(localpart)) {
    return undefined;
  }
  if (!SERVER_NAME_PATTERN.test(serverName)) {
    return undefined;
  }
  return { localpart, serverName };
}

/**
 * The Oxy account a Matrix user id names, or `undefined` when it names none.
 *
 * The exact inverse of {@link matrixUserIdFor}, and as strict: it answers only
 * for an id on `serverName` whose localpart is a well-formed Oxy user id, and
 * nothing else is coerced into being one. Three kinds of MXID are therefore
 * refused, and all three are ordinary rather than exceptional:
 *
 * - **a bridge's puppet** — `@whatsapp_34600111222:allo.you` is a WhatsApp
 *   contact, not an Oxy account, and asking Oxy who it is is wrong at every
 *   level. `lib/chat/roomOrigin.ts` is what recognises those, and
 *   `lib/chat/people.ts` asks it first.
 * - **somebody on another homeserver** — their localpart means whatever their
 *   server decided it means, and it is not an Oxy id even when it looks like
 *   one, which is why the server name is checked before the localpart is.
 * - **a localpart that is not an Oxy id at all.**
 *
 * `undefined` and not a throw, unlike the forward direction: there the caller
 * has asked to name one specific person and must not be handed the wrong one,
 * whereas here the question is asked about every member of every room and "not
 * an Oxy account" is a correct answer with a rendering of its own.
 */
export function oxyUserIdFrom(
  matrixUserId: string,
  serverName: string,
): string | undefined {
  const parts = parseMatrixUserId(matrixUserId);
  if (parts === undefined || parts.serverName !== serverName) {
    return undefined;
  }
  return OXY_USER_ID_PATTERN.test(parts.localpart) ? parts.localpart : undefined;
}

/**
 * Every Matrix user id inside a longer string, in the order they appear and
 * without duplicates.
 *
 * This exists for one thing: **the title both SDKs compute for a room that has
 * no `m.room.name`.** Matrix names such a room after its members, a member with
 * no `displayname` is named after their user id, and nobody on Allo's homeserver
 * has a `displayname` — so the title of a one-to-one conversation is a bare
 * MXID, and the title of an unnamed group is two or three of them joined by
 * whatever the SDK joins them with. Neither is a string this app may draw, and
 * neither can be recovered from anything else the room summary carries.
 *
 * The candidates a scan finds are put through {@link parseMatrixUserId} rather
 * than trusted, so what comes back is a list of complete, well-formed ids and
 * never a fragment of one. Everything else in the string is left alone: a room
 * somebody named "budget@work: 2026" contains no user id and comes back empty.
 */
export function matrixUserIdsIn(text: string): readonly string[] {
  const found: string[] = [];
  for (const match of text.matchAll(MATRIX_USER_ID_IN_TEXT)) {
    const candidate = match[0];
    if (parseMatrixUserId(candidate) !== undefined && !found.includes(candidate)) {
      found.push(candidate);
    }
  }
  return found;
}

/**
 * Where a user id might start and stop inside prose.
 *
 * Wider than the grammar on purpose — every candidate is re-checked by
 * {@link parseMatrixUserId} — but not so wide that it runs past the end of one.
 * The server half is matched as dot-separated labels rather than as "dots and
 * letters", so the full stop at the end of a sentence is not eaten; and the
 * localpart excludes the space, so the next word is not either.
 */
const MATRIX_USER_ID_IN_TEXT =
  /@[\x21-\x39\x3B-\x7E]+:(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(?::\d{1,5})?/g;
