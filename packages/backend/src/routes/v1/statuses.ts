/**
 * `/v1/statuses` — post, read, view, take down.
 *
 * Every route is instance-signed, and every one of them is about ciphertext
 * this server cannot open. What it decides is delivery: which recipient
 * devices it is willing to hand a sealed key to, and who may ask who has seen
 * a status (its author, and nobody else).
 *
 * A status that is not yours answers `not_found` rather than `forbidden`. An
 * id is not proof that a status exists, and a 403 would make it one.
 */

import { Router, type RequestHandler } from "express";
import { createStatusRequestSchema, idSchema } from "@allo/shared-types";
import {
  createStatus,
  deleteStatus,
  listStatuses,
  listStatusViews,
  viewStatus,
} from "../../services/platform/statusService";
import { asyncRoute } from "./asyncRoute";
import { callerOf } from "./conversations";
import { parseBody, parseParam } from "./validate";

export function createStatusRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();

  router.post(
    "/statuses",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const caller = callerOf(req);
      const answer = await createStatus(
        { instanceId: caller.instanceId, accountId: caller.accountId },
        parseBody(createStatusRequestSchema, req),
      );
      res.status(201).json(answer);
    }),
  );

  router.get(
    "/statuses",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const caller = callerOf(req);
      res.json(await listStatuses({ instanceId: caller.instanceId, accountId: caller.accountId }));
    }),
  );

  router.delete(
    "/statuses/:id",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const caller = callerOf(req);
      await deleteStatus(
        { instanceId: caller.instanceId, accountId: caller.accountId },
        parseParam(idSchema, req.params.id, "id"),
      );
      res.status(204).end();
    }),
  );

  router.post(
    "/statuses/:id/views",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const caller = callerOf(req);
      await viewStatus(
        { instanceId: caller.instanceId, accountId: caller.accountId },
        parseParam(idSchema, req.params.id, "id"),
      );
      res.status(204).end();
    }),
  );

  router.get(
    "/statuses/:id/views",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const caller = callerOf(req);
      res.json(
        await listStatusViews(
          { instanceId: caller.instanceId, accountId: caller.accountId },
          parseParam(idSchema, req.params.id, "id"),
        ),
      );
    }),
  );

  return router;
}
