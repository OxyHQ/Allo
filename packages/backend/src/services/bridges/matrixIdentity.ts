import { bridgesConfig } from "../../config/bridges";

/**
 * Translating between an Oxy user id and a Matrix user id.
 *
 * ## Why this is arithmetic and not a collection
 *
 * docs/matrix/data-model.md §6.2 asks for the MXID localpart to be derived
 * DETERMINISTICALLY from the Oxy subject, so that `mxid → oxyUserId` is string
 * arithmetic with no state to fall out of sync. The alternative — a
 * `MatrixIdentity` mapping collection — brings every failure mode a map has:
 * orphans, collisions, and one lost row meaning one user who cannot be
 * provisioned or reported.
 *
 * ## Why an unusable id is refused rather than transformed
 *
 * A Matrix localpart admits only `a-z`, `0-9` and `._=-/+`. The tempting repair
 * for an id that does not fit is to lowercase it and strip what is left over —
 * and that is an account takeover waiting to happen, because two distinct Oxy
 * ids can be mangled into the SAME localpart, and the second user to link would
 * be provisioning the first user's bridge account. Refusing is the only safe
 * answer: it fails one link attempt loudly instead of merging two identities
 * quietly.
 *
 * Allo's Oxy ids are 24-character hexadecimal ObjectIds today, which fit
 * unchanged.
 */

/** The grammar for a freshly-created Matrix localpart. */
const LOCALPART_PATTERN = /^[a-z0-9._=/+-]+$/;

/**
 * The grammar of an Oxy account id: a 24-character lowercase hexadecimal
 * MongoDB ObjectId.
 *
 * Separate from {@link LOCALPART_PATTERN} because they answer different
 * questions, and conflating them is the bug this constant exists to prevent.
 * `LOCALPART_PATTERN` asks "could a homeserver hold this string?" — to which
 * `whatsapp_447700900000` and `telegrambot` both answer yes. This one asks "is
 * this an account on Allo?", to which they answer no: nobody behind a bridge
 * ghost ever signed up, and there is no Oxy user whose id that is.
 */
const OXY_USER_ID_PATTERN = /^[0-9a-f]{24}$/;

/**
 * Whether a string is an Oxy account id.
 *
 * The single place the shape is written down, so that the authentication
 * boundary in `middleware/matrixAuth.ts` and the moderation and bridge paths
 * cannot come to different conclusions about the same string.
 */
export function isOxyUserId(candidate: string): boolean {
  return OXY_USER_ID_PATTERN.test(candidate);
}

/**
 * The Oxy account named by a Matrix localpart, or `undefined` for a localpart
 * that names no Oxy account.
 *
 * This is the direction that has to REFUSE rather than repair. Coming the other
 * way, {@link matrixUserIdForOxyUser} refuses an id it cannot express because
 * two ids mangled into one localpart would provision one user's bridge account
 * for another. Coming this way the same mistake is larger: a localpart accepted
 * as an account id is a request AUTHENTICATED AS that account. A bridge ghost's
 * `whatsapp_447700900000` is not a person on this platform, and neither is the
 * bridge's own `whatsappbot`; the hexadecimal grammar refuses both, along with
 * every other localpart a homeserver might legally hold.
 *
 * Note that {@link oxyUserIdFromMatrixUserId} deliberately does NOT apply this
 * check. Its caller in `services/moderation/subjectIdentity.ts` needs the raw
 * localpart precisely so it can recognise a bridge ghost and say which network
 * it came from, and a refusal there would replace a specific, useful reason
 * with "this homeserver does not own that identifier", which is false.
 */
export function oxyUserIdFromMatrixLocalpart(localpart: string): string | undefined {
  if (!LOCALPART_PATTERN.test(localpart)) return undefined;
  if (!isOxyUserId(localpart)) return undefined;
  return localpart;
}

/**
 * The Oxy account named by a full Matrix user id, or `undefined`.
 *
 * {@link oxyUserIdFromMatrixUserId} composed with
 * {@link oxyUserIdFromMatrixLocalpart}: this homeserver must own the identifier
 * AND the localpart must be an Oxy account id. Use this wherever the answer
 * decides what somebody is allowed to do; use the looser pair where the answer
 * only decides what to tell them.
 */
export function oxyAccountIdFromMatrixUserId(
  matrixUserId: string,
  serverName: string = requireMatrixServerName(),
): string | undefined {
  const localpart = oxyUserIdFromMatrixUserId(matrixUserId, serverName);
  if (localpart === undefined) return undefined;
  return oxyUserIdFromMatrixLocalpart(localpart);
}

/**
 * Matrix user ids are capped at 255 bytes including the sigil and server name,
 * so the localpart budget depends on the server name's length.
 */
const MAX_MATRIX_USER_ID_LENGTH = 255;

export class MatrixIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatrixIdentityError";
  }
}

/**
 * The MXID Allo acts as when provisioning for this user.
 *
 * §5.1's non-negotiable rule: this value is derived from the AUTHENTICATED Oxy
 * identity and never from anything in a request body or query string. The
 * provisioning `shared_secret` makes the bridge believe `?user_id=` without
 * further checks, so an MXID that a client could influence would turn every link
 * endpoint into "link an account for whoever you like".
 */
export function matrixUserIdForOxyUser(
  oxyUserId: string,
  serverName: string = requireMatrixServerName(),
): string {
  const localpart = oxyUserId.trim();

  if (localpart.length === 0) {
    throw new MatrixIdentityError("Oxy user id is empty");
  }
  if (!LOCALPART_PATTERN.test(localpart)) {
    throw new MatrixIdentityError(
      "Oxy user id is not a usable Matrix localpart (allowed: a-z, 0-9 and ._=-/+). " +
        "It is deliberately not transformed: two ids could be mangled into one localpart, " +
        "and that is one user provisioning another user's account",
    );
  }

  const mxid = `@${localpart}:${serverName}`;
  if (Buffer.byteLength(mxid, "utf8") > MAX_MATRIX_USER_ID_LENGTH) {
    throw new MatrixIdentityError(
      `Matrix user id would exceed ${MAX_MATRIX_USER_ID_LENGTH} bytes`,
    );
  }
  return mxid;
}

/**
 * The inverse, for the status webhook — which arrives carrying an MXID and has
 * to find the Oxy user it belongs to.
 *
 * A foreign server name is refused rather than parsed. A bridge is only ever
 * meant to report about users of OUR homeserver, and accepting
 * `@someone:elsewhere.example` would let a compromised or misconfigured bridge
 * write state onto a row keyed by a localpart it does not own.
 */
export function oxyUserIdFromMatrixUserId(
  matrixUserId: string,
  serverName: string = requireMatrixServerName(),
): string | undefined {
  if (!matrixUserId.startsWith("@")) return undefined;
  const separator = matrixUserId.indexOf(":");
  if (separator < 0) return undefined;

  const localpart = matrixUserId.slice(1, separator);
  const host = matrixUserId.slice(separator + 1);
  if (host !== serverName) return undefined;
  if (localpart.length === 0 || !LOCALPART_PATTERN.test(localpart)) return undefined;

  return localpart;
}

/**
 * The configured server name, or a thrown error.
 *
 * `bridgesConfig()` already refuses to parse an environment that enables a
 * network without one, so reaching this throw means bridges are disabled —
 * in which case no route that calls it is mounted.
 */
export function requireMatrixServerName(): string {
  const serverName = bridgesConfig().matrixServerName;
  if (!serverName) {
    throw new MatrixIdentityError(
      "ALLO_MATRIX_SERVER_NAME is not configured, so no Matrix user id can be built",
    );
  }
  return serverName;
}
