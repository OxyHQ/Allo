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
