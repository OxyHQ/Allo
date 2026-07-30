import { Router, type NextFunction, type Request, type Response } from "express";
import { crowdsourceWebhooks } from "@oxyhq/crowdsource-express";
import { crowdSourceConfig } from "../config/crowdsource";
import {
  recordDecisionEvent,
  recordIgnoredEvent,
} from "../services/moderation/ModerationInboundService";
import { mongoProcessedEventStore } from "../services/moderation/moderationEventStore";
import { logger } from "../utils/logger";

/**
 * `POST /webhooks/crowdsource` — where decisions come back.
 *
 * ## The mount is part of the correctness
 *
 * This router MUST be mounted before `express.json()` in `server.ts`. The
 * signature covers `timestamp + "." + rawBody` — the bytes that arrived — and once
 * a JSON parser has run, those bytes are gone. `@oxyhq/crowdsource-express` looks
 * for the raw stream, finds a parsed `req.body` instead, and REFUSES rather than
 * verifying a signature over a re-serialisation. That refusal is the correct
 * behaviour and it is also why the mount order cannot be got wrong silently.
 *
 * `assertRawBody` below turns "cannot be got wrong silently" into "cannot be got
 * wrong at all in a way a test would miss": it fails loudly, at the route, naming
 * the cause. Without it the symptom is a signature mismatch, which reads like a
 * secret problem and sends the next person to rotate a secret that was fine.
 *
 * ## What this handler does and does not do
 *
 * It records and returns. §10.8 asks a receiver to answer 2xx quickly and queue
 * the processing, and the reason is not latency: applying a decision means reading
 * a report, planning enforcement and writing several collections, and a receiver
 * that did all that inline would time out under a burst and be retried while the
 * first attempt was still running. So the event and a durable `decision.apply`
 * outbox row commit in ONE transaction, and the dispatcher does the work.
 *
 * Nothing here is authenticated by Oxy. The HMAC IS the authentication (§10.8),
 * and an Oxy session must never satisfy this route — it is not a user endpoint.
 */

/**
 * One string field out of an event payload this version does not know.
 *
 * `WebhookEventEnvelope.data` is deliberately OPAQUE in the contract: an
 * unrecognised event's payload is whatever a newer CrowdSource decided to send, so
 * this reads the key defensively instead of asserting a shape nobody has verified.
 * Anything that is not a string is treated as absent, which is the only safe
 * reading of a field this deployment has never seen.
 */
function stringField(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const value: unknown = Reflect.get(source, key);
  return typeof value === "string" ? value : undefined;
}

/**
 * Refuse to run if a body parser got here first.
 *
 * `express.json()` sets `req.body` on every request it handles — to `{}` when
 * there is nothing to parse — so an undefined `req.body` is precisely the
 * assertion that NO PARSER RAN. That is a deliberately different claim from "the
 * signature failed to verify", and the difference is the whole reason this guard
 * exists rather than relying on the SDK's own refusal.
 *
 * ## The SDK's protection is conditional on middleware this file does not own
 *
 * `readRawBody` in `@oxyhq/crowdsource-express` resolves the signed bytes in a
 * fixed order: a Buffer on `req.rawBody` FIRST, then a Buffer `req.body`, then a
 * throw if `req.body` is anything else, and only then the request stream. So the
 * failure mode of a late mount is decided entirely by how `express.json()` was
 * configured somewhere else in the app:
 *
 * - **Plain `express.json()`** — what `server.ts` uses today. `req.rawBody` is
 *   never set and `req.body` is a parsed object, so the SDK throws. LOUD.
 * - **`express.json({ verify })` keeping the raw bytes** — the SDK takes that
 *   Buffer and verifies against parser-supplied bytes. The late mount SUCCEEDS,
 *   answers 200, and records the decision. SILENT. (Measured, not assumed:
 *   removing this guard and running the `verify-buffer` case in
 *   `crowdSourceWebhookMount.test.ts` returns exactly 200. Alia's backend has
 *   this configuration.)
 *
 * Allo is in the loud configuration today by accident of unrelated middleware,
 * and a commit that never mentions moderation could move it to the silent one.
 * Hence the assertion is on `req.body` being undefined — true in BOTH
 * configurations — and hence it lives in the route rather than in a test, because
 * what it protects is the mount order in `server.ts`.
 *
 * 500 rather than 4xx: this is Allo misassembled, not a bad request. Answering
 * non-2xx also keeps the delivery on CrowdSource's retry schedule, so decisions
 * are not lost while the deployment is broken — they queue up and arrive once it
 * is fixed.
 */
function assertRawBody(req: Request, res: Response, next: NextFunction): void {
  if (typeof req.body !== "undefined") {
    logger.error(
      "[CrowdSource] webhook received a parsed body: this router is mounted after a body parser. " +
        "The signature covers the bytes that arrived and they are now gone. Mount it before express.json().",
    );
    res.status(500).json({
      error: "Internal Server Error",
      message: "Webhook receiver is misconfigured",
    });
    return;
  }
  next();
}

export function createCrowdSourceWebhookRoutes(): Router {
  const router = Router();

  const config = crowdSourceConfig();
  const secret = config.webhookSecret;
  if (!secret) {
    /**
     * Not mounted, rather than mounted and permissive.
     *
     * A route that answers anything at all without a secret is a route that will
     * one day be reasoned about as if it verified something. An unconfigured
     * deployment 404s here, which is indistinguishable from not having the feature
     * — which is exactly what it is.
     */
    logger.info("[CrowdSource] webhook route not mounted: no CROWDSOURCE_WEBHOOK_SECRET");
    return router;
  }

  router.post(
    "/crowdsource",
    assertRawBody,
    crowdsourceWebhooks({
      secret,
      ...(config.webhookPreviousSecret === undefined
        ? {}
        : { previousSecret: config.webhookPreviousSecret }),
      // Shared across ECS tasks: the in-process default would dedupe only the
      // instance that happened to receive both copies of a redelivery.
      store: mongoProcessedEventStore(),
      on: {
        /**
         * A decision, provisional or final. Both are queued: a provisional decision
         * is real (§9.6) and Allo records it; what it may ACT on is decided by the
         * enforcement mode, not by discarding the event here.
         */
        "case.decided": async (event) => {
          await recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
        /**
         * A later revision replacing an earlier one (§10.6). The SAME path: the
         * decision worker compares revisions and reverses what the superseded
         * revision did. A correction is not a special case with its own code — it
         * is an ordinary decision that supersedes another, and giving it a separate
         * path is how a restore ends up not being idempotent.
         */
        "decision.corrected": async (event) => {
          await recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
        /**
         * An appeal's outcome carries a decision too, and it is the current answer
         * for the case, so it takes the same path.
         */
        "appeal.decided": async (event) => {
          await recordDecisionEvent({
            eventId: event.id,
            type: event.type,
            caseId: event.data.caseId,
            decision: event.data.decision,
          });
        },
      },
      /**
       * Every other event type — including one this version of the contracts
       * package has never heard of (§10.11).
       *
       * Recorded rather than dropped. `case.created`, `case.escalated` and
       * `case.closed` carry no decision and nothing to enforce, but "did CrowdSource
       * tell us about this case, and when" is the first question asked when a report
       * appears stuck, and the answer has to exist somewhere.
       */
      onUnhandled: async (event) => {
        await recordIgnoredEvent({
          eventId: event.id,
          type: event.type,
          caseId: stringField(event.data, "caseId"),
        });
      },
      /**
       * A refusal reason and nothing else — never a body, a header or a signature
       * (§10.8's last line). It is a bounded label from the SDK's own union.
       */
      onRejected: (rejection) => {
        logger.warn("[CrowdSource] webhook delivery refused", { rejection });
      },
    }),
  );

  return router;
}
