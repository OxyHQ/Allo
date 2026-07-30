import { ReportedType } from "../../../models/Report";
import { createUserSubjectProvider } from "./userSubject";
import type { ModerationSubjectProvider } from "./types";

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
 * Allo is end-to-end encrypted with the Signal Protocol. The server stores
 * `Message.ciphertext` and, in `models/Device.ts`, ONLY public key material —
 * `identityKeyPublic`, `signedPreKey.publicKey`, `preKeys[].publicKey`. No private
 * key is ever sent to the server and the backend contains no decryption code at
 * all. So for an encrypted message the server cannot produce a snapshot, and
 * §5.6's requirement to pin "the exact version reported" cannot be satisfied.
 *
 * This is not a limitation to be engineered around. A design in which the server
 * COULD produce that snapshot is a design in which the encryption promise is
 * already false, and the moderation queue would be the reason it became false.
 *
 * ### The loophole, named so nobody re-derives it as a feature
 *
 * Someone reading `models/Message.ts` will see a `text` field sitting right there
 * and wonder why nobody wired `message` up. This is the answer.
 *
 * `Message.text` still exists, commented "legacy plaintext, deprecated, for
 * migration only" — but it is LIVE, not vestigial: `POST /api/messages` still
 * accepts and stores it (`routes/messages.ts`), and the client silently falls back
 * to plaintext when a recipient has no registered device or no preKeys
 * (`packages/frontend/stores/messagesStore.ts`, the `catch` around
 * `encryptMessageForRecipient`).
 *
 * So a `message` provider reading that field would technically WORK. It must still
 * not exist, for two reasons:
 *
 * 1. **Its coverage would be exactly INVERTED.** It could only ever show a jury the
 *    messages that were *not* encrypted — i.e. precisely those sent to users with
 *    no registered device. Moderation would function solely in the app's
 *    least-protected corner, and be blind everywhere the product's promise holds.
 * 2. **It would make the plaintext path load-bearing.** The moment moderation
 *    depended on `Message.text`, the deprecated fallback would acquire a permanent
 *    reason to stay alive — deleting it would "break moderation". A design that
 *    quietly weakens end-to-end encryption to feed a moderation queue is the
 *    failure this whole file exists to avoid, and it would have arrived by
 *    OMISSION rather than by anyone deciding to weaken anything.
 *
 * The absence of a provider is what keeps that path deletable. (The plaintext
 * fallback is itself a live security issue — a silent downgrade in a product whose
 * promise is end-to-end encryption — and is being fixed as its own change. It is
 * deliberately untouched here: a moderation PR is the wrong place to alter the
 * encryption path.)
 *
 * ## Why `conversation` has no provider either
 *
 * A group's `name`, `description` and `avatar` are readable server-side, so this
 * one is not blocked by cryptography — it is blocked by exposure. Allo has no
 * public groups: `Conversation.type` is only `direct` or `group`, every route in
 * `routes/conversations.ts` is scoped to `participants.userId`, and there is no
 * discovery or join-by-link surface. That metadata is visible to MEMBERS only, so
 * sending it to a randomly drawn jury would disclose private group content and,
 * worse, the existence and membership of a private group to people outside it.
 * "Public metadata" is a category Allo does not have.
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
 * signal a participatory review is good at, and it is the one Allo can supply
 * without weakening anything.
 */
const PROVIDERS: readonly ModerationSubjectProvider[] = Object.freeze([
  createUserSubjectProvider(),
]);

const BY_REPORTED_TYPE: ReadonlyMap<string, ModerationSubjectProvider> = new Map(
  PROVIDERS.map((provider) => [provider.reportedType, provider]),
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
 */
export function deliverableTypes(): string[] {
  return Array.from(BY_REPORTED_TYPE.keys());
}

/**
 * The types Allo accepts but never delivers, with the reason recorded on the row.
 *
 * Derived from the enum minus the registry, so adding a `ReportedType` without a
 * provider cannot silently become an undocumented local-only type.
 */
export function localOnlyTypes(): string[] {
  return Object.values(ReportedType).filter((type) => !BY_REPORTED_TYPE.has(type));
}
