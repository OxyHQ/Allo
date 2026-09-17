import { Router, type RequestHandler } from "express";
import { getRequiredOxyUserId } from "@oxy.so/core/server";
import {
  accountIdSchema,
  approveInstanceRequestSchema,
  instanceIdSchema,
  registerInstanceRequestSchema,
  setPushTokenRequestSchema,
} from "@allo/shared-types";
import { getRequiredInstance } from "../../middleware/instanceAuth";
import {
  approveInstance,
  clearInstancePushToken,
  listOwnInstances,
  listPendingEnrollments,
  listPublicInstances,
  registerInstance,
  rejectInstance,
  revokeInstance,
  setInstancePushToken,
} from "../../services/platform/instanceService";
import { notFound } from "../../utils/httpErrors";
import { asyncRoute } from "./asyncRoute";
import { parseBody, parseParam } from "./validate";

export function createInstanceRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();

  // --- Oxy-only: the routes that create or list instances themselves. --------

  router.post(
    "/instances",
    asyncRoute(async (req, res) => {
      const body = parseBody(registerInstanceRequestSchema, req);
      const response = await registerInstance(getRequiredOxyUserId(req), body);
      res.status(201).json(response);
    }),
  );

  router.get(
    "/instances",
    asyncRoute(async (req, res) => {
      res.json({ instances: await listOwnInstances(getRequiredOxyUserId(req)) });
    }),
  );

  router.get(
    "/accounts/:accountId/instances",
    asyncRoute(async (req, res) => {
      const accountId = parseParam(accountIdSchema, req.params.accountId, "accountId");
      const instances = await listPublicInstances(accountId);
      if (instances === null) throw notFound("Account not found");
      res.json({ instances });
    }),
  );

  // --- Instance-signed. `pending` is declared before `:id` so it is not an id. --

  router.get(
    "/instances/pending",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      res.json({ pending: await listPendingEnrollments(me.accountId) });
    }),
  );

  router.put(
    "/instances/me/push",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      await setInstancePushToken(me.id, parseBody(setPushTokenRequestSchema, req));
      res.status(204).end();
    }),
  );

  router.delete(
    "/instances/me/push",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      await clearInstancePushToken(me.id);
      res.status(204).end();
    }),
  );

  router.post(
    "/instances/:id/approve",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      const id = parseParam(instanceIdSchema, req.params.id, "id");
      const body = parseBody(approveInstanceRequestSchema, req);
      const instance = await approveInstance({ id: me.id, accountId: me.accountId }, id, body.approvalSignature);
      res.json({ instance });
    }),
  );

  router.post(
    "/instances/:id/reject",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      const id = parseParam(instanceIdSchema, req.params.id, "id");
      res.json({ instance: await rejectInstance({ id: me.id, accountId: me.accountId }, id) });
    }),
  );

  router.post(
    "/instances/:id/revoke",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      const id = parseParam(instanceIdSchema, req.params.id, "id");
      res.json({ instance: await revokeInstance({ id: me.id, accountId: me.accountId }, id) });
    }),
  );

  return router;
}
