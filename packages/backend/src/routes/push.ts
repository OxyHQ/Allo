import { Router, type Response } from "express";
import type { OxyAuthRequest as AuthRequest } from "@oxyhq/core/server";
import * as z from "zod";

import { pushConfig, PUSH_PLATFORMS, type PushConfig } from "../config/push";
import { mintGatewayUrl } from "../services/push/gatewayToken";
import { sendErrorResponse, sendSuccessResponse } from "../utils/apiHelpers";
import { logger } from "../utils/logger";

/**
 * `POST /api/push/gateway` — where a device is told to send its notifications.
 *
 * The one authenticated half of the push path, and the reason the gateway itself
 * can be authenticated at all. A client registers its pusher with the homeserver
 * and has to give it a URL; that URL carries a capability token bound to the
 * device's own token, and a capability shipped inside the app binary would not
 * be one. So it is minted here, per device, behind the Oxy session — see
 * `services/push/gatewayToken.ts` for what that buys.
 *
 * **Nothing is stored.** The `pushkey` is signed and forgotten in the same
 * function call. That is the whole point of moving to Matrix's pusher registry:
 * Synapse holds the tokens, and a second store here would be one that can
 * disagree with it.
 *
 * The `app_id` comes back from the server rather than being a constant in the
 * app, because the server is the half that decides which app ids it can deliver
 * for. Two constants that have to match, in two repositories, is a mismatch
 * waiting to happen — and its symptom would be pushers that register perfectly
 * and are rejected by their own gateway.
 */

const router = Router();

const requestSchema = z.object({
  platform: z.enum(PUSH_PLATFORMS),
  /**
   * The device token from the operating system: an APNs token or an FCM
   * registration token. Bounded because it is signed and echoed back, never
   * parsed, and an unbounded string here is an unbounded string in a URL that
   * ends up in the homeserver's database.
   */
  pushkey: z.string().trim().min(1).max(1024),
});

router.post("/gateway", (req: AuthRequest, res: Response) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendErrorResponse(
      res,
      400,
      "Bad Request",
      "A push gateway URL is minted for one device: send a platform and that device's pushkey",
    );
  }

  const config: PushConfig = pushConfig();
  const appId = config.appIdByPlatform.get(parsed.data.platform);
  if (!config.enabled || appId === undefined) {
    /**
     * 404, the same answer a disabled bridge network gives. A deployment without
     * iOS push configured does not have an iOS push endpoint, and saying so as
     * "forbidden" would suggest there is something to be let into.
     */
    return sendErrorResponse(
      res,
      404,
      "Not Found",
      `This deployment does not deliver push notifications for ${parsed.data.platform}`,
    );
  }

  const [mintingSecret] = config.gatewaySecrets;
  if (config.gatewayUrl === undefined || mintingSecret === undefined) {
    /**
     * Unreachable through `loadPushConfig`, which refuses to boot a configured
     * platform without both. Answered rather than asserted because the honest
     * report to a client is that the server cannot do this right now, and
     * throwing here would be a 500 that says nothing.
     */
    logger.error("[Push] a platform is configured but its gateway URL or secret is missing");
    return sendErrorResponse(
      res,
      503,
      "Service Unavailable",
      "Push notifications are not available on this deployment right now",
    );
  }

  const url = mintGatewayUrl(config.gatewayUrl, mintingSecret, {
    appId,
    pushkey: parsed.data.pushkey,
  });

  // Neither the pushkey nor the minted URL is logged: one is a device token and
  // the other is the capability over it.
  return sendSuccessResponse(res, 200, { url, appId });
});

export default router;
