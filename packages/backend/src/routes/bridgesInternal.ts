import { createHash, timingSafeEqual } from "crypto";
import express, { Router, type Request, type Response } from "express";
import {
  bridgesConfig,
  enabledBridgeNetworks,
  type EnabledBridgeNetwork,
} from "../config/bridges";
import { getDb } from "../db";
import { findSlotOwner } from "../db/bridges/accounts";
import {
  applyBridgeState,
  parseBridgeStateReport,
} from "../services/bridges/BridgeStatusService";
import { proxyUrlForSlot } from "../services/bridges/proxy/ProxyLeaseService";
import { logger } from "../utils/logger";

/**
 * `/internal/bridges/*` — called by the bridges, never by the app
 * (docs/matrix/bridges.md §5.2, §5.4, §8.3 rule 6).
 *
 * ## Mounted before `express.json()` and before Oxy authentication
 *
 * Same placement as `/webhooks` for CrowdSource, for a related reason: an Oxy
 * session must never satisfy these routes, and a per-user rate limiter must
 * never throttle them. Mounting ahead of both means that is a property of the
 * assembly rather than of a check somebody remembered to write. The router
 * brings its OWN body parser, so it is not relying on middleware mounted after
 * it.
 *
 * ## Authentication
 *
 * - `POST /status` — `Authorization: Bearer <as_token>`, compared in constant
 *   time against every enabled network's token. The token that matches also
 *   IDENTIFIES the bridge, which is what lets one endpoint serve all of them.
 * - `GET /proxy` — a `?t=` secret, separate from any bridge's provisioning
 *   shared secret and rotatable on its own (§4.3). Without it, anyone who
 *   reached the endpoint could enumerate which user egresses through which
 *   geography.
 */

export function createBridgeInternalRoutes(): Router {
  const router = Router();
  const config = bridgesConfig();

  if (!config.enabled) {
    /**
     * Not mounted, rather than mounted and answering. A route that responds
     * without any bridge configured is one that will eventually be reasoned
     * about as if it authenticated something. An unconfigured deployment 404s,
     * which is indistinguishable from not having the feature — which is what it
     * is.
     */
    logger.info("[Bridges] internal routes not mounted: no network is enabled");
    return router;
  }

  router.use(express.json({ limit: "64kb" }));

  /**
   * `POST /internal/bridges/status` — a bridge reporting a connection change.
   *
   * Always 2xx once authenticated, including for reports that match no account.
   * Bridges report their own lifecycle too (`STARTING`, `UNCONFIGURED`), and a
   * non-2xx would put a message that can never match onto a retry schedule
   * forever.
   */
  router.post("/status", async (req: Request, res: Response) => {
    const network = authenticateBridge(req);
    if (!network) {
      logger.warn("[Bridges] status report refused: no bridge token matched");
      res.status(401).json({ error: "Unauthorized", message: "Unknown bridge token" });
      return;
    }

    const report = parseBridgeStateReport(req.body);
    if (!report) {
      res.status(400).json({ error: "Bad Request", message: "Not a bridge state report" });
      return;
    }

    try {
      const result = await applyBridgeState(network, report);
      res.status(200).json({ matched: result.matched });
    } catch (error) {
      /**
       * 5xx keeps the report on the bridge's retry schedule, so a state change
       * is not lost while Allo is broken. The report's contents are deliberately
       * absent from the log: it names a user and their remote account.
       */
      logger.error("[Bridges] failed to apply a status report", error);
      res.status(500).json({ error: "Internal Server Error", message: "Could not apply" });
    }
  });

  /**
   * `GET /internal/bridges/proxy` — what a per-user bridge process egresses through.
   *
   * Mounted only when a proxy provider is configured, because without one there
   * is no network that could ask (§9.2 rule 2).
   *
   * **The field must be called `proxy_url`**: that is what the bridge
   * deserialises. A 5xx or invalid JSON here fails the bridge's connection
   * outright, so the handler touches nothing slow — the composed URL is served
   * from an in-memory cache invalidated by rotation (§8.3 rule 6).
   */
  if (config.proxy?.endpointToken) {
    const endpointToken = config.proxy.endpointToken;

    router.get("/proxy", async (req: Request, res: Response) => {
      const suppliedToken = req.query.t;
      if (
        typeof suppliedToken !== "string" ||
        !constantTimeEquals(suppliedToken, endpointToken)
      ) {
        /**
         * 404, not 403. The same answer as an unknown slot, so this endpoint
         * cannot be used to confirm that a slot id exists.
         */
        res.status(404).json({ error: "Not Found" });
        return;
      }

      const slotId = req.query.slot;
      if (typeof slotId !== "string" || slotId.length === 0) {
        res.status(404).json({ error: "Not Found" });
        return;
      }

      try {
        const proxyUrl = await proxyUrlForSlot(slotId, (slot) =>
          findSlotOwner(getDb(), slot),
        );

        if (!proxyUrl) {
          /**
           * No URL for this slot — unknown slot, no lease, or a QUARANTINED
           * lease. The bridge fails to connect, which for the quarantine case is
           * the intended outcome: better an account that does not connect than
           * one that connects from a country we have already decided is wrong
           * (§8.3 rule 5).
           */
          res.status(404).json({ error: "Not Found" });
          return;
        }

        res.status(200).json({ proxy_url: proxyUrl });
      } catch (error) {
        logger.error("[Bridges] failed to serve a proxy URL", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });
  } else {
    logger.info(
      "[Bridges] proxy endpoint not mounted: no proxy provider or no ALLO_BRIDGE_PROXY_ENDPOINT_TOKEN",
    );
  }

  return router;
}

/**
 * Which bridge sent this, by its registration's `as_token`.
 *
 * Every enabled network is compared, and the loop does NOT stop at the first
 * match. Returning early would make the response time depend on the token's
 * position in the list — a side channel that leaks how many bridges are
 * configured and, over enough requests, which one a token belongs to.
 */
function authenticateBridge(req: Request): EnabledBridgeNetwork | undefined {
  const header = req.get("authorization");
  if (typeof header !== "string" || !header.toLowerCase().startsWith("bearer ")) {
    return undefined;
  }
  const token = header.slice("bearer ".length).trim();
  if (token.length === 0) return undefined;

  let matched: EnabledBridgeNetwork | undefined;
  for (const network of enabledBridgeNetworks()) {
    if (constantTimeEquals(token, network.asToken)) matched = network;
  }
  return matched;
}

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Both sides are hashed first so the comparison is over fixed-length buffers:
 * `timingSafeEqual` throws on a length mismatch, and catching that throw would
 * itself be a length oracle — an attacker learns the token's length by watching
 * which requests fail differently.
 */
function constantTimeEquals(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash("sha256").update(supplied, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}
