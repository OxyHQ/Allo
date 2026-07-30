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
 * There is a tempting loophole, and it is worth naming so nobody re-derives it as
 * a feature. `Message.text` still exists as a deprecated migration field, and the
 * client falls back to plaintext when a recipient has no registered device
 * (`packages/frontend/stores/messagesStore.ts`). A `message` provider reading that
 * field would technically work — and its coverage would be exactly inverted: it
 * could only ever show a jury the messages that were NOT encrypted. Moderation
 * would function solely in the app's least-protected corner, and the deprecated
 * plaintext path would acquire a permanent reason to stay alive. The absence of a
 * provider is what keeps that path deletable.
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
