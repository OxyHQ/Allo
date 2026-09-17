import { Router, type RequestHandler } from "express";
import { ackSyncRequestSchema, syncQuerySchema } from "@allo/shared-types";
import { ackSync, readSync } from "../../services/platform/eventService";
import { asyncRoute } from "./asyncRoute";
import { callerOf } from "./conversations";
import { parseBody, parseQuery } from "./validate";

export function createSyncRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();
  router.use("/sync", deps.instanceAuth);

  router.get(
    "/sync",
    asyncRoute(async (req, res) => {
      res.json(await readSync(callerOf(req), parseQuery(syncQuerySchema, req)));
    }),
  );

  router.post(
    "/sync/ack",
    asyncRoute(async (req, res) => {
      const body = parseBody(ackSyncRequestSchema, req);
      await ackSync(callerOf(req), body.cursor);
      res.status(204).end();
    }),
  );

  return router;
}
