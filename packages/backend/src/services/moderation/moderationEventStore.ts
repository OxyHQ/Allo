import type { ProcessedEventStore } from "@oxyhq/crowdsource-express";
import {
  claimModerationEvent,
  releaseModerationEvent,
} from "../../db/moderation/moderationEventRepository";

/**
 * The webhook dedupe store, in Postgres.
 *
 * `@oxyhq/crowdsource-express` defaults to an in-process store and says exactly
 * when that is not enough: two instances behind a load balancer each keep their
 * own, so a redelivery landing on the other instance is not deduplicated. Allo
 * runs on ECS Fargate behind one ALB, so this is that case.
 *
 * The claim/release contract is the store's, and it is the right one. A row
 * inserted BEFORE the handler runs means a concurrent redelivery cannot also run
 * it; deleting that row when the handler THROWS means §10.9's retry schedule can
 * still deliver the event later. Recording the id only after success would let two
 * copies run at once; recording it before and never releasing would make a
 * transient failure permanent and lose a decision silently.
 *
 * ## The duplicate-key `catch` is gone, and that is the point of the port here
 *
 * Under Mongo the "already claimed" answer arrived as a duplicate-key ERROR that
 * this file recognised by inspecting `code === 11000` — so the one thing that
 * MUST propagate (a lost connection, a failover, an exhausted pool) was separated
 * from the one thing that must not, by a condition one mis-widened `catch` away
 * from answering 200 to a decision nobody ever handled. `claimModerationEvent`
 * returns the answer as a BOOLEAN, from `on conflict do nothing … returning`, so
 * a duplicate never throws and everything that does throw reaches the caller
 * untouched. There is no longer a catch here to widen.
 */

export function postgresProcessedEventStore(): ProcessedEventStore {
  return {
    /** True when this call took the claim. */
    claim: (eventId: string) => claimModerationEvent(eventId),

    /** Give the claim back so a redelivery can be processed. */
    release: (eventId: string) => releaseModerationEvent(eventId),
  };
}
