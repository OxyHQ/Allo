import { REPORTED_TYPES } from "../../../db/schema/moderation";
import { createUserSubjectProvider } from "./userSubject";
import type { AccountReportedType, ModerationSubjectProvider } from "./types";

/**
 * Every noun Allo can send for review, and the §5.4 type it is.
 *
 * There is exactly one, and the reason is the product.
 *
 * ## This list decides DELIVERY, and nothing else
 *
 * A reported type with a provider here is sent to CrowdSource. A reported type
 * WITHOUT one is still accepted by `POST /reports` and still stored — it simply
 * never leaves. The registry is not an admission gate on the API. A gate that
 * refused unwired types would mean an application breaks its own report surfaces
 * on the day it adopts CrowdSource, and in Allo it would mean refusing the single
 * most important report a messaging app receives: "this message is abusive".
 * That report is still worth taking. It is just not reviewable by strangers.
 *
 * ## Why `message` has no provider, and would not gain one by trying harder
 *
 * Allo is end-to-end encrypted (`docs/platform/crypto.md`). The server stores
 * and relays ciphertext; it never holds a decryption key and contains no
 * decryption code. So for a message the server cannot produce a snapshot, and
 * §5.6's requirement to pin "the exact version reported" cannot be satisfied.
 *
 * This is not a limitation to be engineered around. A design in which the server
 * COULD produce that snapshot is a design in which the encryption promise is
 * already false, and the moderation queue would be the reason it became false.
 * There is no plaintext branch anywhere in the backend for a provider to read
 * from, and the absence of a provider is what keeps it that way: the moment
 * moderation depended on readable content, readable content would acquire a
 * permanent reason to exist.
 *
 * ## Why `conversation` has no provider either
 *
 * A conversation's name is itself an encrypted application message on the new
 * engine, so the server cannot read it; and even the membership that the server
 * does hold is visible to MEMBERS only. Allo has no public groups and no
 * discovery surface, so sending it to a randomly drawn jury would disclose the
 * existence and membership of a private group to people outside it. "Public
 * metadata" is a category Allo does not have.
 *
 * ## Why a reporter's own consent does not unlock `message` either
 *
 * The obvious next idea: a reporter is a participant, so they hold the plaintext
 * client-side and could attach an excerpt they consent to disclose. It is a real
 * pattern and it is not implemented, for three reasons that have to be answered
 * TOGETHER — the first two are policy, the third is a missing primitive:
 *
 * 1. **The other party did not consent.** A conversation excerpt is by definition
 *    somebody else's words as well. One participant cannot consent on behalf of
 *    the other, and a two-party conversation has no excerpt that discloses only
 *    the reporter's half.
 * 2. **§5.6 would be pinning something unverifiable.** The snapshot hash would
 *    cover a client-supplied blob the server cannot check against anything,
 *    because the server never had the plaintext. The identity binding proof would
 *    attest that the reporter SENT it — not that it was ever SAID. A reporter
 *    could fabricate an excerpt wholesale and the case would look every bit as
 *    well-formed as a true one.
 * 3. **Making (2) false needs cryptography Allo does not have.** The primitive is
 *    sender-attributable franking (a per-message tag the recipient can prove the
 *    sender produced, without the server reading the message). That is a change to
 *    the messaging protocol, not to this module. Shipping a weaker version —
 *    signing the excerpt with the reporter's key, say — produces evidence that
 *    LOOKS binding and is not, which is worse than having none, because a jury
 *    cannot tell the difference.
 *
 * So this stays a product-and-protocol decision. If it is ever taken, it belongs
 * in a change that adds franking first; a provider added here without it would
 * silently convert reason (2) into a case nobody can audit.
 *
 * ## What is left, and why it is enough to be worth doing
 *
 * An account. Reports about a user carry no conversation material — a jury sees
 * the profile and the allegation. Conduct across many reports is precisely the
 * pattern a participatory review is good at, and it is the one Allo can supply
 * without weakening anything. That decision is enforced by the TYPE of
 * {@link ModerationSubjectProvider}, not by a condition in this file — see
 * `AccountReportedType` in `./types`. A condition is something a later change can
 * relax while the tests still pass; a type is something a later change has to
 * argue with.
 */
/**
 * Keyed by {@link AccountReportedType} rather than held in an array, so the set is
 * CLOSED rather than merely short.
 *
 * A `readonly ModerationSubjectProvider[]` accepts a second element; this record
 * does not accept a second key. A `message: …` key here is an excess
 * property and does not compile, and omitting `user` is a missing one — the
 * registry cannot silently become empty either, which is the failure the vacuity
 * assertion in `subjectProviders.test.ts` was written to catch.
 */
const PROVIDERS: Readonly<Record<AccountReportedType, ModerationSubjectProvider>> =
  Object.freeze({
    user: createUserSubjectProvider(),
  });

const BY_REPORTED_TYPE: ReadonlyMap<string, ModerationSubjectProvider> = new Map(
  Object.values(PROVIDERS).map((provider) => [provider.reportedType, provider]),
);

/**
 * The provider for a reported type, or `undefined` when it is not deliverable.
 *
 * The single authority on whether a report leaves this deployment.
 * `ReportIntakeService` asks before queueing a delivery, and
 * `EvidenceSnapshotService` asks again when it builds one; a type this returns
 * `undefined` for is stored and never enqueued.
 */
export function subjectProviderFor(
  reportedType: string,
): ModerationSubjectProvider | undefined {
  return BY_REPORTED_TYPE.get(reportedType);
}

/**
 * The reported types wired to CrowdSource, as the registry itself sees them.
 *
 * Exists so a test can pin the set. That is not ceremony: the difference between a
 * delivered type and a local-only one is invisible in a 201, so registering a
 * provider — or forgetting to — is a change no response body would reveal. In Allo
 * the assertion is a privacy control, not a coverage metric: the test that pins
 * this set to exactly `['user']` is what would fail if someone ever wired
 * `message` up, and that failure is the entire point.
 *
 * Pinning the set is necessary and not sufficient. A provider registered under
 * `user` could still describe conversation material as context and leave this
 * set untouched, so the same test also pins the module graph `subjects/` is
 * allowed to reach: a conversation cannot be described without importing
 * something that knows what one is.
 */
export function deliverableTypes(): string[] {
  return Array.from(BY_REPORTED_TYPE.keys());
}

/**
 * The types Allo accepts but never delivers, with the reason recorded on the row.
 *
 * Derived from the reportable-type tuple minus the registry, so adding a
 * `ReportedType` without a provider cannot silently become an undocumented
 * local-only type. The tuple is the same one `reports_reported_type_check` is
 * rendered from, which is what keeps "every accepted type" here equal to every
 * type the database will store.
 */
export function localOnlyTypes(): string[] {
  return REPORTED_TYPES.filter((type) => !BY_REPORTED_TYPE.has(type));
}
