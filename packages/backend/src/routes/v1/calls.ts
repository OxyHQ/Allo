/**
 * `/v1/calls` — ring, answer, decline, hang up.
 *
 * Nothing about the media passes through here. The offer, the candidates and
 * the keys are encrypted messages in the conversation; these routes move the
 * state machine that decides whose phone rings and whose stops.
 *
 * A call that is not yours answers `not_found` rather than `forbidden`: an id
 * is not proof that a call exists, and a 403 would make it one.
 */

import { Router, type RequestHandler } from "express";
import { createCallRequestSchema, endCallRequestSchema, idSchema } from "@allo/shared-types";
import { answerCall, callIceServers, callSfuToken, createCall, declineCall, endCall, readCall } from "../../services/platform/callService";
import { asyncRoute } from "./asyncRoute";
import { callerOf } from "./conversations";
import { parseBody, parseParam } from "./validate";

export function createCallRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();

  router.post(
    "/calls",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = callerOf(req);
      const answer = await createCall(
        { instanceId: me.instanceId, accountId: me.accountId },
        parseBody(createCallRequestSchema, req),
      );
      res.status(201).json(answer);
    }),
  );

  router.get(
    "/calls/:id",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = callerOf(req);
      res.json(
        await readCall({ instanceId: me.instanceId, accountId: me.accountId }, parseParam(idSchema, req.params.id, "id")),
      );
    }),
  );

  /**
   * Where to send the media, and whether the client may offer its own address.
   * Asked per call rather than per account, because "relayed" is a property of
   * the CALL: either side hiding makes it true for both.
   */
  router.get(
    "/calls/:id/ice",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = callerOf(req);
      res.json(
        await callIceServers(
          { instanceId: me.instanceId, accountId: me.accountId },
          parseParam(idSchema, req.params.id, "id"),
        ),
      );
    }),
  );

  /**
   * The SFU ticket, for a GROUP call and only once this device has answered.
   * A 1:1 call never comes here: its media is peer to peer, or through the
   * TURN relay that `/ice` hands out.
   */
  router.get(
    "/calls/:id/token",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = callerOf(req);
      res.json(
        await callSfuToken({ instanceId: me.instanceId, accountId: me.accountId }, parseParam(idSchema, req.params.id, "id")),
      );
    }),
  );

  router.post(
    "/calls/:id/answer",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = callerOf(req);
      res.json(
        await answerCall({ instanceId: me.instanceId, accountId: me.accountId }, parseParam(idSchema, req.params.id, "id")),
      );
    }),
  );

  router.post(
    "/calls/:id/decline",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = callerOf(req);
      res.json(
        await declineCall({ instanceId: me.instanceId, accountId: me.accountId }, parseParam(idSchema, req.params.id, "id")),
      );
    }),
  );

  router.post(
    "/calls/:id/end",
    deps.instanceAuth,
    asyncRoute(async (req, res) => {
      const me = callerOf(req);
      const body = parseBody(endCallRequestSchema, req);
      res.json(
        await endCall(
          { instanceId: me.instanceId, accountId: me.accountId },
          parseParam(idSchema, req.params.id, "id"),
          body.reason,
        ),
      );
    }),
  );

  return router;
}
