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
