import { Router, type RequestHandler } from "express";
import { getRequiredOxyUserId } from "@oxy.so/core/server";
import {
  accountIdSchema,
  approveInstanceRequestSchema,
  instanceIdSchema,
  registerInstanceRequestSchema,
  setPushTokenRequestSchema,
  setTransferKeyRequestSchema,
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
  setInstanceTransferKey,
} from "../../services/platform/instanceService";
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
      res.json({ instances: await listPublicInstances(accountId) });
    }),
  );

  /**
   * `DELETE /v1/instances/:id` — remove one of YOUR OWN devices with the Oxy
   * session instead of that device's signing key.
   *
   * The signed route below is the everyday one: a device you still hold takes
   * another off the account. This one exists for the case that route cannot
   * reach — the last active device is gone (site data cleared, phone lost,
   * a key that did not survive), so there is no signing key left to authorise
   * anything with, and a newly enrolled device waits for an approval that can
   * never come. Without a session-authenticated way out, the ACCOUNT is
   * finished, which is not a thing a messenger may do to somebody.
   *
   * It is the same trade every major makes — WhatsApp and Signal both let the
   * account's own credential re-register a device and sign the others out —
   * and it is written down in `docs/platform/threat-model.md`: an Oxy session
   * can remove this account's devices, so a stolen Oxy token can take the
   * account over going forward. It cannot read a word of what came before:
   * history is end-to-end encrypted and reaches a new device only by an
   * approved transfer or the recovery phrase. And it is loud — every device it
   * removes learns it was revoked.
   */
  router.delete(
    "/instances/:id",
    asyncRoute(async (req, res) => {
      const id = parseParam(instanceIdSchema, req.params.id, "id");
      res.json({ instance: await revokeInstance(getRequiredOxyUserId(req), id) });
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

  router.put(
    "/instances/me/transfer-key",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = getRequiredInstance(req);
      const instance = await setInstanceTransferKey(me.id, parseBody(setTransferKeyRequestSchema, req));
      res.json({ instance });
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
      res.json({ instance: await revokeInstance(me.accountId, id) });
    }),
  );

  return router;
}
