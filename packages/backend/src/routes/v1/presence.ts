/**
 * `GET /v1/presence?accountIds=a,b,c` — the state of a watch set, at once.
 *
 * The socket is how presence CHANGES arrive; this is how a screen starts.
 * A client that has just opened a conversation list has a set of accounts and
 * no state for any of them, and waiting for the first change would draw
 * everybody as offline until somebody happened to connect.
 *
 * Instance-signed like everything else: an Oxy token alone cannot ask who is
 * online. The rules deciding what comes back are in `presenceService.ts`.
 */

import { Router, type RequestHandler } from "express";
import { presenceQuerySchema } from "@allo/shared-types";
import { readPresence } from "../../services/platform/presenceService";
import { asyncRoute } from "./asyncRoute";
import { callerOf } from "./conversations";
import { parseQuery } from "./validate";

export function createPresenceRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();

  router.get(
    "/presence",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const { accountIds } = parseQuery(presenceQuerySchema, req);
      res.json(await readPresence(callerOf(req).accountId, accountIds));
    }),
  );

  return router;
}
