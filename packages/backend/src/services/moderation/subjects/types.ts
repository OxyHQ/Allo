/**
 * The seam that makes this integration copyable.
 *
 * §5 opens by naming the mistake to avoid: designing moderation around `post`,
 * `comment`, `room` or `product`. CrowdSource's side of that is already solved —
 * the Case Envelope knows nothing about any of them, and `@oxyhq/crowdsource`
 * composes one from a description of the material. What is left for an
 * application is a translation problem, and this file is the whole of it:
 *
 *     "given one of MY nouns and its id, describe the material"
 *
 * Everything downstream — digests, resource ids, relations, principal bindings,
 * the binding proof, the policy version, privacy terms, the idempotency key, the
 * envelope itself — is composed by the SDK from that description and is IDENTICAL
 * for every application and every subject type. So adding a subject type is one
 * file implementing {@link ModerationSubjectProvider} plus one line in the
 * registry — in every application except this one, where the third rule below
 * deliberately makes it more than that.
 *
 * Two rules keep it that way, and both are load-bearing rather than stylistic:
 *
 * 1. **A provider returns a DESCRIPTION, never an envelope.** The types below are
 *    the SDK's own input types, re-exported unchanged. A provider that built an
 *    envelope would have to invent resource ids and principal refs, and §7.3's
 *    dedup key is computed over exactly those — two reporters describing one
 *    account would open two cases, and "one penalty per incident" would fail in
 *    production with nothing failing in a test.
 * 2. **A provider is pure translation with reads.** It fetches its own object and
 *    returns; it does not decide whether to deliver, what the allegation is, or
 *    what happens to the report. Those belong to callers that are shared.
 *
 * ## In Allo there is a third rule, and it outranks both
 *
 * **A provider may only describe an ACCOUNT.** Allo is end-to-end encrypted; the
 * server holds ciphertext and public keys. A provider is the ONLY place where a
 * decision to disclose could be made, so it is the place the constraint has to be
 * stated. A provider that reached for message plaintext would not be a feature — it
 * would be the point at which the encryption promise quietly stopped being true.
 *
 * The rule used to be "may only describe material the server can legitimately
 * read", and Matrix bridges are why it was tightened. A bridged room is NOT
 * encrypted — the bridge holds the far side's keys and participates as a member —
 * so the server genuinely can read one, and the old rule would have permitted a
 * provider there. docs/matrix/data-model.md §6.4 says no, and the two types below
 * are how that answer is enforced by the compiler rather than by a condition
 * somebody could relax.
 */

import type { ContextInput, ReportSubjectInput, ResourceInput } from "@oxyhq/crowdsource";

/**
 * The reported types a provider may be registered for: the ones whose identifier
 * names an account.
 *
 * A TYPE rather than a runtime list, and that is the whole point of §6.4. The
 * hazard it closes is not "somebody adds a `message` provider" — that is loud, and
 * `subjectProviders.test.ts` fails on it. The hazard is the version that reads
 * REASONABLY in a pull request: *"bridged rooms are not encrypted, so for those we
 * CAN describe a message"*. A provider conditioned on the room's encryption state
 * is a one-line diff, it is true on its own terms, and it is exactly the failure —
 * a WhatsApp conversation disclosed to a jury drawn from strangers.
 *
 * Written as a type, that change stops being a one-line diff. `reportedType:
 * "message"` is not assignable to this alias, so the registry does not compile
 * until somebody widens the alias — an edit to THIS file, under this comment,
 * which is a deliberate act and a reviewable one. The three standing reasons are in
 * `registry.ts`; the two extra sentences a bridge adds are there too.
 */
export type AccountReportedType = "user";

/**
 * §5.4's subject types Allo may emit: the identity realm, and nothing else.
 *
 * The counterpart of {@link AccountReportedType}, and it closes the same door from
 * the other side. A provider could otherwise keep `reportedType: "user"` — passing
 * every assertion that pins the deliverable SET — while describing a bridged room
 * as `content.room` or hanging its messages off `context`. The subject type is what
 * a jury is told it is looking at, so constraining it to the identity realm is what
 * makes "a jury sees a profile and an allegation" a property of the type system
 * rather than a description of today's code.
 */
export type IdentitySubjectType = "identity.profile";

/**
 * The SDK's resource description, unchanged.
 *
 * Re-exported as a type alias so a provider imports the vocabulary from this seam
 * rather than from several places — but it IS the SDK's type, not a local
 * restatement of it. A resource type added to the contract becomes available to
 * every provider the moment the dependency is bumped.
 */
export type ModerationResource = ResourceInput;
export type ModerationContextResource = ContextInput;

/**
 * One reported object, described.
 *
 * `content` is required because a report with no material is a question a jury
 * cannot answer. An application that cannot produce the material for one of its
 * nouns should not register a provider for it — see the registry, where this is
 * the governing fact rather than an edge case.
 */
export interface ModerationSubjectSnapshot {
  /** Identity, type and author of the reported object (§5.1 `subject`). */
  readonly subject: ReportSubjectInput;
  /** The reported material itself. A string is shorthand for plain text. */
  readonly content: string | ModerationResource;
  /** Media carried BY the subject. */
  readonly attachments?: readonly ModerationResource[];
  /**
   * Surrounding material a jury needs to judge fairly. Context, not extra
   * exposure: §9.1 keeps a reviewer's view to the minimum that makes the question
   * answerable.
   */
  readonly context?: readonly ModerationContextResource[];
  /**
   * SHA-256 of the exact representation being reviewed, stored on the local
   * report so a decision about an older version stays identifiable as such
   * (§5.6). Computed by `EvidenceSnapshotService`, not by the provider — one
   * definition of "the hash of this snapshot" for every subject type.
   */
  readonly snapshotHash?: string;
}

/**
 * Translates one of the application's nouns into universal material.
 *
 * `subjectType` is declared on the provider rather than returned per snapshot
 * because it is a property of the noun (§5.4): every Allo account report is an
 * `identity.profile`. Keeping it here means the registry can answer "what does
 * this application report?" without loading a single object.
 */
export interface ModerationSubjectProvider {
  /** The application's own name for the noun, as it arrives on a report. */
  readonly reportedType: AccountReportedType;
  /** §5.4's namespaced subject type. */
  readonly subjectType: IdentitySubjectType;
  /**
   * Describes the object, or returns `null` when it no longer exists.
   *
   * `null` is not a failure. An account deleted between the report and its
   * delivery is ordinary, and it is the caller's job to decide what that means — a
   * provider that threw would make deletion look like an outage and be retried
   * for days.
   *
   * `reportedId` is always an OXY user id (§6.2). An MXID is translated at the
   * edge, in `services/moderation/subjectIdentity.ts`, and a subject that has no
   * Oxy account never reaches a provider at all — so nothing here has to know that
   * Matrix exists, and no provider has an identifier it could resolve to a room.
   */
  snapshot(reportedId: string): Promise<ModerationSubjectSnapshot | null>;
}
