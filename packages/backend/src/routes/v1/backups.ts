/**
 * The account backup: `PUT`, `GET`, `DELETE /v1/accounts/me/backup`, all
 * instance-signed. The path says `me` and not an account id because the
 * backup is the caller's own account's and nobody else's; the instances
 * router's `/accounts/:accountId/instances` is a different resource and
 * does not collide.
 */

import { Router, type RequestHandler } from "express";
import { putBackupRequestSchema } from "@allo/shared-types";
import { getRequiredInstance } from "../../middleware/instanceAuth";
import { deleteAccountBackup, getAccountBackup, putAccountBackup } from "../../services/platform/backupService";
import { asyncRoute } from "./asyncRoute";
import { parseBody } from "./validate";

export function createBackupRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();

  router.put(
    "/accounts/me/backup",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      const backup = await putAccountBackup({ id: me.id, accountId: me.accountId }, parseBody(putBackupRequestSchema, req));
      res.json({ backup });
    }),
  );

  router.get(
    "/accounts/me/backup",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      res.json({ backup: await getAccountBackup(me.accountId) });
    }),
  );

  router.delete(
    "/accounts/me/backup",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      await deleteAccountBackup(me.accountId);
      res.status(204).end();
    }),
  );

  return router;
}
