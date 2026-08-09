import type { TaxonomyCode } from "@oxyhq/crowdsource-contracts";
import type { ReportCategory } from "../../db/schema/moderation";

/**
 * Allo's report categories, translated into CrowdSource's universal taxonomy.
 *
 * The categories on the left are what a reporter picked. The codes on the right
 * are ALLEGATIONS (§6.2) — what is claimed, never what is true. A jury classifies
 * the material itself and may confirm a different code entirely, and nothing about
 * this table shortens that.
 *
 * ## Why this is versioned
 *
 * §6.4 requires every decision to record the policy version it was decided under,
 * and this mapping is upstream of that: change what `spam` means and two reports
 * filed a month apart are no longer the same allegation.
 * {@link REPORT_TAXONOMY_VERSION} is stamped into the report metadata so a case
 * can always be read back against the mapping that produced it. Bump it in the
 * same change that alters a row.
 *
 * ## An allegation about an account, judged on a profile
 *
 * Worth stating because it changes how these codes are read in Allo and nowhere
 * else. Every report Allo delivers is about an ACCOUNT, and the material a jury
 * sees is that account's profile — never a conversation. So `harassment.targeted_abuse`
 * here does not mean "these messages are abusive"; it means "this account is
 * alleged to be abusive, and here is who they present themselves as". A jury that
 * cannot substantiate the allegation from a profile alone is expected to say so,
 * and `insufficient_context` is the correct outcome rather than a failure of the
 * integration. That honesty is the point: the alternative is disclosing the
 * conversation.
 */
export const REPORT_TAXONOMY_VERSION = "2026.07";

const CATEGORY_TO_ALLEGATION: Readonly<Record<ReportCategory, TaxonomyCode>> = Object.freeze({
  spam: "integrity.spam",
  hate_speech: "hate.protected_targeting",
  harassment: "harassment.targeted_abuse",
  /**
   * `misinformation` has no home in §6.3's eleven families — the closest are
   * `integrity.coordinated_manipulation` (a claim about organised behaviour) and
   * `integrity.scam` (a claim about intent to defraud), neither of which is what a
   * reporter clicking "misinformation" is alleging. `other.policy_specific` is a
   * real code meaning "against the reporting application's rules, and the universal
   * taxonomy has no name for it". Forcing it into `integrity.*` would tell a jury
   * the reporter alleged something they did not.
   */
  misinformation: "other.policy_specific",
  /**
   * The activity code, not the nudity code. They are different claims and Allo
   * offers one category for both; the stronger code is the honest reading of what
   * a reporter means by "explicit", and a jury that finds only nudity will say so.
   * Alleging nudity when explicit activity was reported would understate the report
   * and could route it to a lighter review.
   */
  explicit_content: "sexual_content.explicit_activity",
  other: "other.unclassifiable",
});

/**
 * The allegation codes for a report's categories, deduplicated and ORDERED.
 *
 * Order is not cosmetic. Ingress fingerprints the whole envelope to detect §10.5's
 * "same external id, different body", so a list whose order depended on how a
 * client happened to send its categories would turn a legitimate outbox retry into
 * a permanent 409 — days later, as a report silently stuck in a queue. Sorting
 * makes the same report produce the same bytes every time.
 */
export function allegationsForCategories(
  categories: readonly ReportCategory[],
): TaxonomyCode[] {
  const codes = new Set<TaxonomyCode>();
  for (const category of categories) {
    const code = CATEGORY_TO_ALLEGATION[category];
    // A category the map does not cover cannot silently become nothing: a report
    // with no allegation is not a report.
    codes.add(code ?? "other.unclassifiable");
  }
  return Array.from(codes).sort();
}
