import express, { Router, type Request, type Response } from "express";

import {
  PUSH_GATEWAY_NOTIFY_PATH,
  pushConfig,
  type PushConfig,
  type PushPlatform,
} from "../config/push";
import type { PushSender } from "../services/push/delivery";
import { dispatchPushNotification } from "../services/push/dispatch";
import {
  GATEWAY_TOKEN_PARAMETER,
  verifyGatewayToken,
} from "../services/push/gatewayToken";
import {
  parsePushNotification,
  plaintextFieldsPresent,
  type PushNotificationDevice,
} from "../services/push/notification";
import { pushSenders } from "../services/push/senders";
import { logger } from "../utils/logger";

/**
 * `POST /_matrix/push/v1/notify` — the Matrix Push Gateway API.
 *
 * ## Called by Synapse, never by a user
 *
 * Which is why it is mounted in `server.ts` **ahead of `express.json()`, ahead
 * of the Oxy authentication middleware and ahead of the per-user rate limiter**,
 * exactly as `/webhooks` and `/internal/bridges` are. A homeserver has no Oxy
 * session and never will; putting the route behind that middleware would mean it
 * could only ever answer 401. Mounting it here makes "an Oxy session cannot
 * satisfy this route" a property of the assembly rather than of a check somebody
 * has to remember. The router brings its own body parser for the same reason.
 *
 * ## How it is secured
 *
 * The Push Gateway API has no authentication of its own, and an unauthenticated
 * push gateway on the public internet is a spam relay pointed at your own users'
 * phones. So every pusher's URL carries a capability token, minted per device
 * behind Oxy authentication by `routes/push.ts` and bound by HMAC to that
 * device's `app_id` and `pushkey`. The full argument, including what this does
 * not protect against, is in `services/push/gatewayToken.ts`.
 *
 * Two failures, two different answers, and the difference matters:
 *
 * - **No token at all** is a 401. Nothing that ever registered a pusher with
 *   this deployment can produce such a request, so it is a scanner, and a 401
 *   costs it nothing of ours.
 * - **A token that does not match a device** puts that device in `rejected`.
 *   It means the pusher was minted by somebody else — another deployment, a
 *   secret that has been rotated out entirely, a forgery — and a pusher this
 *   gateway can never serve is worth more deleted than retried forever. It is
 *   also self-healing: the app mints a fresh URL and re-registers on its next
 *   launch. The cost of getting this wrong is why `ALLO_PUSH_GATEWAY_SECRETS`
 *   is a list; rotate by prepending, and drop the old one only once every
 *   installation has launched again.
 */

export interface PushGatewayDependencies {
  readonly config: PushConfig;
  readonly senders: ReadonlyMap<PushPlatform, PushSender>;
}

export function createPushGatewayRoutes(
  dependencies: Partial<PushGatewayDependencies> = {},
): Router {
  const router = Router();
  const config = dependencies.config ?? pushConfig();

  if (!config.enabled) {
    /**
     * Not mounted, rather than mounted and answering. Same rule as the bridge
     * internal routes: a deployment with no push configured 404s, which is
     * indistinguishable from not having the feature — which is what it is.
     */
    logger.info("[Push] the gateway is not mounted: no push platform is configured");
    return router;
  }

  const senders = dependencies.senders ?? pushSenders(config);

  /**
   * Its own parser, with a small limit. The body is a list of device
   * identifiers and two ids; anything approaching this size is not one.
   */
  router.use(express.json({ limit: "64kb" }));

  router.post(PUSH_GATEWAY_NOTIFY_PATH, async (req: Request, res: Response) => {
    const suppliedToken = req.query[GATEWAY_TOKEN_PARAMETER];
    if (typeof suppliedToken !== "string" || suppliedToken.length === 0) {
      // The URL is never logged: it carries the capability.
      logger.warn("[Push] a notification arrived with no gateway token");
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const notification = parsePushNotification(req.body);
    if (notification === undefined) {
      res.status(400).json({ error: "Bad Request", message: "Not a push notification" });
      return;
    }

    /**
     * A pusher registered with the wrong format is the one way message plaintext
     * could reach this server, and it would do so silently — everything below
     * works either way. Names only, never values: logging the content would be
     * the same leak with a longer retention period.
     */
    const leaked = plaintextFieldsPresent(req.body);
    if (leaked.length > 0) {
      logger.warn(
        "[Push] a notification carried fields that event_id_only excludes, so some pusher is " +
          "registered with the wrong format",
        { fields: leaked },
      );
    }

    const authenticated: PushNotificationDevice[] = [];
    const unauthenticated: string[] = [];
    for (const device of notification.devices) {
      if (
        verifyGatewayToken(
          suppliedToken,
          { appId: device.appId, pushkey: device.pushkey },
          config.gatewaySecrets,
        )
      ) {
        authenticated.push(device);
      } else {
        unauthenticated.push(device.pushkey);
      }
    }

    if (unauthenticated.length > 0) {
      logger.warn("[Push] a notification named devices its token does not authenticate", {
        count: unauthenticated.length,
      });
    }

    if (authenticated.length === 0) {
      res.status(200).json({ rejected: unauthenticated });
      return;
    }

    try {
      const result = await dispatchPushNotification(
        { ...notification, devices: authenticated },
        senders,
        config.platformByAppId,
      );
      const rejected = [...new Set([...unauthenticated, ...result.rejected])];
      /**
       * A 502 is what puts the notification back on Synapse's retry schedule, and
       * it is the reference gateway's behaviour for the same reason: the
       * alternative to a duplicate is a message nobody was told about. Devices
       * that already received it are collapsed on the event id by both senders,
       * so a retry replaces the first attempt rather than ringing twice.
       */
      res.status(result.hasTransientFailure ? 502 : 200).json({ rejected });
    } catch (error) {
      logger.error("[Push] a notification could not be dispatched", error);
      res.status(500).json({ error: "Internal Server Error", rejected: unauthenticated });
    }
  });

  return router;
}
