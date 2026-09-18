/**
 * History offers. Every route is instance-signed: an offer is made BY an
 * instance (the donor signs the manifest with the same key that signs the
 * request) TO an instance, and only the recipient reads or consumes it.
 *
 * `POST /v1/instances/:id/history-offers` — `:id` is the recipient. It is
 * declared with the recipient in the path AND in the body
 * (`recipientInstanceId`); the two must agree, so a body copied from one
 * request cannot be posted at another instance's path by mistake.
 */

import { Router, type RequestHandler } from "express";
import { createHistoryOfferRequestSchema, idSchema, instanceIdSchema } from "@allo/shared-types";
import { getRequiredInstance } from "../../middleware/instanceAuth";
import { consumeOffer, createHistoryOffer, listPendingHistoryOffers } from "../../services/platform/historyService";
import { validationFailed } from "../../utils/httpErrors";
import { asyncRoute } from "./asyncRoute";
import { parseBody, parseParam } from "./validate";

export function createHistoryRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();

  // `me` before `:id`, so it is never read as an id.
  router.get(
    "/instances/me/history-offers",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      res.json({ offers: await listPendingHistoryOffers({ id: me.id, accountId: me.accountId }) });
    }),
  );

  router.post(
    "/instances/me/history-offers/:id/consume",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      const id = parseParam(idSchema, req.params.id, "id");
      res.json({ offer: await consumeOffer({ id: me.id, accountId: me.accountId }, id) });
    }),
  );

  router.post(
    "/instances/:id/history-offers",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      const recipientId = parseParam(instanceIdSchema, req.params.id, "id");
      const request = parseBody(createHistoryOfferRequestSchema, req);
      if (request.recipientInstanceId !== recipientId) {
        throw validationFailed("recipientInstanceId does not match the instance in the path");
      }
      const offer = await createHistoryOffer({ id: me.id, accountId: me.accountId }, request);
      res.status(201).json({ offer });
    }),
  );

  return router;
}
