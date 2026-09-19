import {
  crowdSourceForOxyService,
  resetCrowdSourceForOxyService,
  type CrowdSource,
} from "@crowdsource.you/core";

import { crowdSourceConfig } from "../../config/crowdsource";
import { logger } from "../../utils/logger";

/**
 * Allo's CrowdSource client, which is now one library call plus the base URL.
 *
 * Everything this file used to hold — build once, decide whether the process can
 * authenticate at all, log the reason exactly once, resolve the tenant so an
 * unbound application is visible at boot — moved into `@crowdsource.you/core`'s
 * `crowdSourceForOxyService()`. It had to: Mention and Homiio each carried their
 * own copy of these same sixty-nine lines, ours being Mention's with the name
 * swapped, and none of those decisions were ever Allo's to make.
 *
 * ## Allo holds no CrowdSource service key any more
 *
 * The client presents the Oxy service token this process can already mint and
 * CrowdSource resolves the tenant from the Oxy application that token names
 * (oxy ADR 0026). So `CROWDSOURCE_SERVICE_KEY` is gone from `config/crowdsource.ts`
 * — nothing reads it — and `applicationId` still appears nowhere here, now for a
 * second reason: the token names an OXY application, and which CrowdSource tenant
 * that is, is a question only CrowdSource can answer.
 *
 * ## `CROWDSOURCE_ENABLED` is not checked here, on purpose
 *
 * It is Allo's policy and it stays where it is acted on — `ModerationOutboxDispatcher`,
 * the one thing gated on it, so that intake keeps writing outbox events while the
 * integration is off and switching it on delivers the backlog. Re-asking it here
 * would be a second gate on the same fact, in front of the only caller that is
 * already behind the first.
 */

/**
 * The client, or `undefined` where this process cannot authenticate as Allo.
 *
 * `undefined` rather than a throw: a local checkout can attest no task role and
 * holds no key pair, and a report filed there must still be STORED. The delivery
 * worker is what notices there is nowhere to send it.
 */
export function getCrowdSourceClient(): CrowdSource | undefined {
  const config = crowdSourceConfig();
  return crowdSourceForOxyService({
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    logger: {
      info: (message, context) => logger.info(message, context),
      error: (message, context) => logger.error(message, context),
    },
  });
}

/** Test hook. Production builds the client once and keeps it for the process. */
export function resetCrowdSourceClient(): void {
  resetCrowdSourceForOxyService();
}
