import { BRIDGE_NETWORK_CATALOG, BRIDGE_NETWORK_IDS, bridgesConfig } from "../../config/bridges";
import type { BridgeNetworkId } from "../../config/bridges";
import { oxyUserIdFromMatrixUserId } from "../bridges/matrixIdentity";

/**
 * What a reported identifier actually names, and whether CrowdSource can judge it.
 *
 * docs/matrix/data-model.md §6.2 keeps `Report.reportedId` an OXY user id and puts
 * the MXID → Oxy translation at the EDGE rather than inside the delivery pipeline.
 * This module is that edge. It answers one question — "is this identifier an Oxy
 * account, and if it is not, what is it?" — and it is a TOTAL function, so there is
 * no identifier for which the answer is silence.
 *
 * ## Silence is the failure being removed
 *
 * Before Matrix a `reportedId` was always an Oxy user id and the question did not
 * exist. Matrix introduces identifiers that look like accounts and are not: a user
 * on a homeserver Allo does not run, and the ghost users an appservice creates for
 * the far side of a bridge (`@whatsapp_…`). Handing one of those to
 * `oxyClient.getUserById` produces a 404, which `userSubject` correctly turns into
 * `null`, which `ModerationDeliveryWorker` correctly reads as "the account no longer
 * exists" — and the report closes with a sentence that was never true of a subject
 * that never had an Oxy account at all.
 *
 * §6.3 requires that outcome to be DECIDED and written down rather than inferred
 * from a 404, which is what `reason` is for: it lands verbatim in
 * `Report.localStatusReason`, next to the reason a reported message never leaves.
 *
 * ## Why a room, an alias and an event id are classified here too
 *
 * §6.5: Matrix gives Allo a second reporting channel — `reportContent(eventId, …)`
 * and `reportRoom(reason)` — addressed to the HOMESERVER ADMINISTRATOR, not to
 * CrowdSource. Two recipients, two authorities, two vocabularies of consequence,
 * and one hard rule: **an event id must never reach CrowdSource.** It names one
 * message in one room, which is conversation metadata of exactly the kind that does
 * not leave this deployment.
 *
 * Classifying all three conversation sigils here means an event id cannot become
 * deliverable by being pasted into the wrong field. The alternative — a check at
 * whichever call site somebody remembered — holds until the second call site.
 *
 * ## Why this is arithmetic and not a lookup
 *
 * §6.2 requires the MXID localpart to be derived deterministically from the Oxy
 * subject, so the inverse is string arithmetic with no state to fall out of sync.
 * `services/bridges/matrixIdentity.ts` owns that arithmetic and this module reuses
 * it rather than restating the grammar: one definition of "an MXID this homeserver
 * owns" for provisioning and for moderation, because two would eventually disagree
 * about one user.
 */

/**
 * The longest identifier Allo will take a report about.
 *
 * 255 bytes is Matrix's own ceiling for a user id, sigil and server name included,
 * and `services/bridges/matrixIdentity.ts` already refuses to build anything longer.
 * An Oxy ObjectId is 24 bytes and a room alias is bounded by the same spec limit,
 * so nothing legitimate comes close.
 *
 * ## What an unbounded identifier actually costs
 *
 * Not a rejected insert. The composite unique index was the first suspicion and it
 * is wrong: WiredTiger dropped the 1024-byte index key limit in FCV 4.2, and the
 * server this runs against takes a megabyte-long `reportedId` without complaint.
 *
 * The real cost is downstream, and §6.3 is what makes it reachable — an identifier
 * that resolves to nothing is deliberately STORED rather than refused, so untrusted
 * bytes reach Mongo by design and the only question is how many:
 *
 * 1. **A stuck outbox slot, permanently.** A `user` report with a megabyte
 *    identifier still gets a delivery event, and `oxyClient.getUserById` puts that
 *    identifier in a URL path. What comes back is not a 404 — it is a request-line
 *    or header-size failure, or a transport error, and `isOxyUserNotFound` does not
 *    recognise it. The provider rethrows, the outbox reads that as an OUTAGE, and
 *    the event is retried forever instead of closing. One report, one delivery slot,
 *    gone for good.
 * 2. **Unbounded attacker-controlled rows in an indexed field.** `reportedId` is
 *    indexed twice, and any authenticated user can write it.
 * 3. It would otherwise ride out as `subject.externalId` and `author.oxyUserId` in
 *    a CrowdSource envelope, which is somebody else's parser.
 *
 * Bytes, not characters: the limits that eventually bite are byte limits, and a
 * 255-character identifier of astral-plane codepoints is a kilobyte.
 */
export const MAX_REPORTED_IDENTIFIER_BYTES = 255;

/**
 * Control characters and whitespace, neither of which appears in any identifier
 * Allo can legitimately receive.
 *
 * An Oxy ObjectId is hexadecimal; a Matrix user id, room id, alias and event id are
 * all defined without whitespace. So this rejects nothing real, and it refuses the
 * shapes that make an identifier act like something other than an identifier: a
 * newline in a value that reaches a log line and a URL path, a `\0` that truncates
 * in a C-backed layer, a bidi override that makes an operator read one account name
 * while the row holds another.
 *
 * The value has already been trimmed by the time it gets here, so leading and
 * trailing spaces are forgiven and interior ones are not.
 */
const FORBIDDEN_IDENTIFIER_CHARACTERS =
  /[\s\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/u;

/**
 * The reason a reported identifier is unusable, or `undefined` when it is fine.
 *
 * Returns a reason rather than throwing, because its two callers owe their users
 * different things: `POST /api/reports` owes a 400 with a message, and
 * `createReport` owes a `TypeError` to whatever called it without a route. One
 * definition of the rule, two shapes of refusal — the alternative is a route that
 * catches a `TypeError` and guesses which of several causes produced it.
 *
 * Both borders check, and that is deliberate rather than redundant. `createReport`
 * is exported and the route is only its first caller; a guard that lives at one
 * caller is a guard that holds until the second one arrives.
 */
export function reportedIdentifierProblem(identifier: string): string | undefined {
  const bytes = Buffer.byteLength(identifier, "utf8");
  if (bytes > MAX_REPORTED_IDENTIFIER_BYTES) {
    return `reportedId must be at most ${MAX_REPORTED_IDENTIFIER_BYTES} bytes, received ${bytes}`;
  }
  if (FORBIDDEN_IDENTIFIER_CHARACTERS.test(identifier)) {
    return "reportedId must not contain whitespace or control characters";
  }
  return undefined;
}

/**
 * A reported identifier, resolved.
 *
 * Binary on purpose. Everything downstream needs one bit — can CrowdSource judge
 * this subject — and a richer enum would invite a `switch` inside the pipeline,
 * which is the coupling §6.2 removes by keeping the translation at the edge. The
 * detail that survives is prose, because its only consumer is a human reading a
 * report row months later.
 */
export type ModerationSubjectIdentity =
  | {
      readonly kind: "oxy-account";
      /**
       * The canonical identifier: an Oxy user id, whether the caller supplied one
       * directly or an MXID this homeserver owns.
       */
      readonly reportedId: string;
    }
  | {
      readonly kind: "not-an-oxy-account";
      /**
       * The identifier as it was given. There is no Oxy id to canonicalise it to,
       * and inventing one would be the silent failure this module exists to remove.
       */
      readonly reportedId: string;
      /**
       * Why CrowdSource cannot judge this subject, in a sentence an operator can
       * read without re-deriving anything. Stored verbatim in
       * `Report.localStatusReason`, which the schema bounds to 300 characters; a
       * test pins that every reason below fits, because an overflowing reason would
       * fail schema validation inside intake's transaction and take the whole
       * report down with it.
       */
      readonly reason: string;
    };

/**
 * Matrix's identifier sigils, and what each one names.
 *
 * Only `@` can possibly be an account. `!`, `#` and `$` name a room, a room alias
 * and an event — locations in a conversation, never principals.
 */
const MATRIX_USER_SIGIL = "@";
const MATRIX_ROOM_SIGIL = "!";
const MATRIX_ROOM_ALIAS_SIGIL = "#";
const MATRIX_EVENT_SIGIL = "$";

/**
 * The half of every reason that is the same fact: CrowdSource judges Oxy accounts.
 *
 * Shared so the sentence a reporter's row carries cannot drift into six slightly
 * different claims about what CrowdSource does.
 */
const NOT_REVIEWABLE =
  "CrowdSource reviews Oxy accounts only, so this report is recorded locally and is not sent for community review.";

const ROOM_REASON = `The reported identifier names a Matrix room rather than an account. ${NOT_REVIEWABLE}`;

const ROOM_ALIAS_REASON = `The reported identifier names a Matrix room alias rather than an account. ${NOT_REVIEWABLE}`;

/**
 * An event id is refused for a second reason on top of "it is not an account", and
 * the reason is written on the row because it is the one an operator would
 * otherwise have to look up: it is conversation metadata (§6.5).
 */
const EVENT_REASON = `The reported identifier names a single Matrix event, which is conversation metadata and never leaves this deployment. ${NOT_REVIEWABLE}`;

const FOREIGN_HOMESERVER_REASON = `The reported identifier is a Matrix user on a homeserver Allo does not run, so it has no Oxy account. ${NOT_REVIEWABLE}`;

/**
 * Reached when a Matrix identifier arrives in a deployment that has no Matrix
 * configured. The honest answer is "this cannot be resolved here", not a guess: a
 * localpart read out of an MXID whose homeserver is unknown is not an Oxy user id,
 * it is a string that happens to be shaped like one.
 */
const MATRIX_UNCONFIGURED_REASON = `Matrix is not configured in this deployment, so a Matrix identifier cannot be resolved to an Oxy account. ${NOT_REVIEWABLE}`;

function bridgedIdentityReason(network: BridgeNetworkId): string {
  const { displayName } = BRIDGE_NETWORK_CATALOG[network];
  return (
    `The reported identifier is a ${displayName} identity created by a bridge, not an Oxy account: ` +
    `nobody behind it ever signed up to Allo. ${NOT_REVIEWABLE}`
  );
}

/**
 * The appservice localpart namespaces, derived from the catalogue rather than
 * listed a second time.
 *
 * A mautrix bridge owns two shapes of localpart on Allo's homeserver: one ghost per
 * remote user (`@whatsapp_<remote id>`) and one bot per bridge (`@whatsappbot`).
 * Deriving both from `BRIDGE_NETWORK_IDS` means a network added to the catalogue
 * cannot be forgotten here — a second list agrees with the first until the day it
 * does not, and that day is the day a bridged identity is mistaken for an account.
 *
 * Matched for every network in the CATALOGUE, not only the enabled ones. A ghost
 * whose network was turned off after the room was created is still not an Oxy
 * account, and a report about one is not something turning a flag back on would fix.
 *
 * Allo's Oxy ids are 24-character hexadecimal ObjectIds, which contain no `_` and
 * no letter past `f`, so no real account id can land in one of these namespaces.
 * An id format that could would be misread as a bridge ghost and its reports would
 * stay local — the safe direction of the two, and one this comment exists to make
 * findable if the id format ever changes.
 */
function bridgedNetworkForLocalpart(localpart: string): BridgeNetworkId | undefined {
  return BRIDGE_NETWORK_IDS.find(
    (network) => localpart.startsWith(`${network}_`) || localpart === `${network}bot`,
  );
}

function notAnOxyAccount(reportedId: string, reason: string): ModerationSubjectIdentity {
  return { kind: "not-an-oxy-account", reportedId, reason };
}

function resolveMatrixUser(matrixUserId: string): ModerationSubjectIdentity {
  const serverName = bridgesConfig().matrixServerName;
  if (serverName === undefined) {
    return notAnOxyAccount(matrixUserId, MATRIX_UNCONFIGURED_REASON);
  }

  /**
   * `undefined` covers both a foreign homeserver and a malformed MXID, and they
   * share a reason because they share the only fact that matters: this homeserver
   * does not own the identifier, so Allo cannot say whose account it is.
   */
  const localpart = oxyUserIdFromMatrixUserId(matrixUserId, serverName);
  if (localpart === undefined) {
    return notAnOxyAccount(matrixUserId, FOREIGN_HOMESERVER_REASON);
  }

  const network = bridgedNetworkForLocalpart(localpart);
  if (network !== undefined) {
    return notAnOxyAccount(matrixUserId, bridgedIdentityReason(network));
  }

  return { kind: "oxy-account", reportedId: localpart };
}

/**
 * Resolve a reported identifier to the Oxy account it names, or to the reason it
 * names none.
 *
 * An identifier bearing no Matrix sigil is an Oxy user id and is returned trimmed —
 * which is every report Allo takes today, so nothing about the pre-Matrix path
 * changes shape. Emptiness is NOT checked here: `ReportIntakeService.createReport`
 * refuses a blank identifier at the point the query is built, where the check also
 * guards against a query operator arriving where an id belongs, and duplicating it
 * here would put two answers in the system for one question.
 */
export function resolveModerationSubject(reportedId: string): ModerationSubjectIdentity {
  const identifier = reportedId.trim();

  switch (identifier.charAt(0)) {
    case MATRIX_USER_SIGIL:
      return resolveMatrixUser(identifier);
    case MATRIX_ROOM_SIGIL:
      return notAnOxyAccount(identifier, ROOM_REASON);
    case MATRIX_ROOM_ALIAS_SIGIL:
      return notAnOxyAccount(identifier, ROOM_ALIAS_REASON);
    case MATRIX_EVENT_SIGIL:
      return notAnOxyAccount(identifier, EVENT_REASON);
    default:
      return { kind: "oxy-account", reportedId: identifier };
  }
}

/**
 * Every reason this module can produce, for the test that pins them against the
 * schema's limit.
 *
 * Exported rather than re-derived by the test: a reason added here and forgotten
 * there would be one unbounded string that only fails in production, inside a
 * transaction, on the report that carries it.
 */
export function moderationSubjectReasons(): string[] {
  return [
    ROOM_REASON,
    ROOM_ALIAS_REASON,
    EVENT_REASON,
    FOREIGN_HOMESERVER_REASON,
    MATRIX_UNCONFIGURED_REASON,
    ...BRIDGE_NETWORK_IDS.map(bridgedIdentityReason),
  ];
}
