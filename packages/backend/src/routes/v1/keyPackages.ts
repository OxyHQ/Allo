import { Router, type RequestHandler } from "express";
import { claimKeyPackagesRequestSchema, uploadKeyPackagesRequestSchema } from "@allo/shared-types";
import { getRequiredInstance } from "../../middleware/instanceAuth";
import { claimKeyPackages, countKeyPackageStock, uploadKeyPackages } from "../../services/platform/keyPackageService";
import { asyncRoute } from "./asyncRoute";
import { parseBody } from "./validate";

export function createKeyPackageRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();

  router.get(
    "/key-packages",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      res.json(await countKeyPackageStock(getRequiredInstance(req).id));
    }),
  );

  router.put(
    "/key-packages",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      res.json(await uploadKeyPackages(me.id, parseBody(uploadKeyPackagesRequestSchema, req)));
    }),
  );

  router.post(
    "/key-packages/claim",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      const body = parseBody(claimKeyPackagesRequestSchema, req);
      res.json(await claimKeyPackages(me.id, body.instanceIds));
    }),
  );

  return router;
}
