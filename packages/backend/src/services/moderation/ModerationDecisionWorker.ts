import { DecisionSchema } from "@oxyhq/crowdsource-contracts";
import Report, { type LeanReport } from "../../models/Report";
import { crowdSourceConfig } from "../../config/crowdsource";
import { logger } from "../../utils/logger";
import type { ModerationOutboxEvent } from "./ModerationOutboxService";
import { reportStateForDecision } from "./reportStatus";

/**
 * Applying a decision that came back.
 *
 * The decision is parsed HERE rather than at the webhook (§10.11): an event whose
 * shape this deployment does not recognise is kept in the outbox until the code
 * catches up, instead of being refused at the door and retried until it
 * dead-letters.
 *
 * ## Allo ships in `observe` mode, and there is a second reason beyond caution
 *
 * `observe` is the safe first rollout everywhere. In Allo it is also the only mode
 * with anything to run, because **Allo has no platform-level sanction primitive.**
 * `Block` and `Restrict` are per-user relations — "user X will not hear from user
 * Y" — written by a user about their own inbox. There is no account-level
 * restriction, no delivery suspension and no global mute for a decision to invoke.
 *
 * So this worker records the decision and stops. Manufacturing an enforcement path
 * — writing `Block` rows on behalf of users who did not ask, or inventing a
 * platform restriction with no delivery-side code to honour it — would be a product
 * decision with real consequences for real accounts, made by a moderation worker
 * because a field said `violation`. Recording the decision is genuinely useful on
 * its own: it is the durable record of conduct across reports, and it is what a
 * future enforcement mechanism would be built to read.
 *
 * `enforcedAction` is therefore written as the action Allo WOULD take, never as
 * one it did, and `enforcedAt` stays unset until something actually acts.
 */

const MAX_DECISION_SUMMARY_LENGTH = 200;

/** A decision event that can never be applied. Dead-lettered, not retried. */
export class ModerationDecisionRejectedError extends Error {
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "ModerationDecisionRejectedError";
  }
}

/**
 * What Allo would do about an outcome.
 *
 * Deliberately small, because Allo's vocabulary of consequences is small. There is
 * no `label_sensitive` or `unlabel_sensitive`: labelling means annotating material,
 * and Allo cannot read the material. A `violation` maps to `restrict` as the
 * intent, `no_violation` to `restore`, and every non-verdict outcome to
 * `manual_review` — because "we could not tell" is a question for a person, not a
 * silent `none`.
 */
export function plannedActionForOutcome(
  outcome: string,
): "restrict" | "restore" | "manual_review" {
  switch (outcome) {
    case "violation":
      return "restrict";
    case "no_violation":
      return "restore";
    default:
      return "manual_review";
  }
}

/** Handle one `decision.apply` outbox event. */
export async function applyDecisionOutboxEvent(
  event: ModerationOutboxEvent,
): Promise<void> {
  const caseId = event.payload.caseId;
  if (caseId === undefined) {
    throw new ModerationDecisionRejectedError("A decision.apply event carried no caseId.");
  }

  const parsed = DecisionSchema.safeParse(event.payload.decision);
  if (!parsed.success) {
    /**
     * Retryable, NOT dead-lettered. A decision this deployment cannot parse is far
     * more likely to be a newer CrowdSource than a corrupt payload, and the outbox
     * keeps it for days — long enough to deploy a contracts bump and have the
     * backlog apply itself. Dead-lettering here would discard a real decision
     * because this deployment was behind.
     */
    throw new Error(
      `Decision for case '${caseId}' does not match the known contract: ${parsed.error.message.slice(0, MAX_DECISION_SUMMARY_LENGTH)}`,
    );
  }
  const decision = parsed.data;

  const report = await Report.findOne({ crowdSourceCaseId: caseId }).lean<LeanReport | null>();
  if (!report) {
    /**
     * A decision about a case this deployment has no report for. Not an error: a
     * case can be merged (§7.3) so the decision may name a case another report
     * opened, and a report can be deleted. Nothing to apply and nothing to retry.
     */
    logger.warn("[CrowdSource] decision has no local report", { caseId });
    return;
  }

  /**
   * A superseded revision is not the current answer, and an OLDER revision
   * arriving late must never overwrite a newer one. §10.6 allows redelivery and
   * reordering, so the comparison is against what is stored, not against arrival
   * order.
   */
  const storedRevision = report.decisionRevision ?? 0;
  if (decision.revision <= storedRevision) {
    logger.info("[CrowdSource] ignoring superseded decision revision", {
      caseId,
      arrived: decision.revision,
      stored: storedRevision,
    });
    return;
  }

  const state = reportStateForDecision({
    outcome: decision.outcome,
    decisionStatus: decision.status,
  });
  const plannedAction = plannedActionForOutcome(decision.outcome);
  const mode = crowdSourceConfig().enforcementMode;

  await Report.updateOne(
    { _id: report._id, decisionRevision: report.decisionRevision ?? null },
    {
      $set: {
        status: state.status,
        localStatus: state.localStatus,
        decisionId: decision.id,
        decisionRevision: decision.revision,
        decisionOutcome: decision.outcome,
        decisionStatus: decision.status,
        decidedAt: new Date(),
        /**
         * The action Allo would take. Written in every mode, acted on in none —
         * see this file's header. When an enforcement mechanism exists, it reads
         * this field; until then it is the record of what was decided.
         */
        enforcedAction: plannedAction,
      },
    },
  );

  logger.info("[CrowdSource] decision recorded", {
    caseId,
    outcome: decision.outcome,
    revision: decision.revision,
    plannedAction,
    enforcementMode: mode,
    enforced: false,
  });
}
