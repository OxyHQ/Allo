import { Router, type RequestHandler } from "express";
import {
  conversationIdSchema,
  createConversationRequestSchema,
  putGroupInfoRequestSchema,
  resetConversationRequestSchema,
} from "@allo/shared-types";
import { getRequiredInstance } from "../../middleware/instanceAuth";
import { getRealtime } from "../../runtime/realtime";
import {
  createConversation,
  getConversation,
  leaveConversation,
  listConversations,
  resetConversation,
  type Caller,
} from "../../services/platform/conversationService";
import { getGroupInfo, putGroupInfo } from "../../services/platform/groupInfoService";
import { asyncRoute } from "./asyncRoute";
import { parseBody, parseParam } from "./validate";

export function callerOf(req: Parameters<typeof getRequiredInstance>[0]): Caller {
  const me = getRequiredInstance(req);
  return { instanceId: me.id, accountId: me.accountId, appId: me.appId };
}

export function createConversationRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();
  router.use("/conversations", deps.instanceAuth);

  router.post(
    "/conversations",
    asyncRoute(async (req, res) => {
      const body = parseBody(createConversationRequestSchema, req);
      const result = await createConversation(callerOf(req), body);
      if (result.nudges.length > 0) getRealtime().nudge(result.nudges, { conversationId: result.conversation.id });
      res.status(result.created ? 201 : 200).json({ conversation: result.conversation, created: result.created });
    }),
  );

  router.get(
    "/conversations",
    asyncRoute(async (req, res) => {
      res.json({ conversations: await listConversations(callerOf(req)) });
    }),
  );

  router.get(
    "/conversations/:id",
    asyncRoute(async (req, res) => {
      const id = parseParam(conversationIdSchema, req.params.id, "id");
      res.json({ conversation: await getConversation(callerOf(req), id) });
    }),
  );

  /**
   * Revive a conversation whose MLS group has no active leaf left. The rule —
   * that the group is provably dead — is enforced in the service, because it
   * is the only thing standing between this and a way to take over a live
   * conversation.
   */
  router.post(
    "/conversations/:id/reset",
    asyncRoute(async (req, res) => {
      const id = parseParam(conversationIdSchema, req.params.id, "id");
      const body = parseBody(resetConversationRequestSchema, req);
      const result = await resetConversation(callerOf(req), id, body);
      if (result.nudges.length > 0) getRealtime().nudge(result.nudges, { conversationId: result.conversation.id });
      res.json({ conversation: result.conversation });
    }),
  );

  router.post(
    "/conversations/:id/leave",
    asyncRoute(async (req, res) => {
      const id = parseParam(conversationIdSchema, req.params.id, "id");
      await leaveConversation(callerOf(req), id);
      res.status(204).end();
    }),
  );

  /**
   * The stored GroupInfo a leafless member joins from (`groupInfoService.ts`).
   * The body of the `PUT` is `{ epoch, data: base64 }`: opaque public MLS
   * material the server stores and never parses.
   */
  router.get(
    "/conversations/:id/group-info",
    asyncRoute(async (req, res) => {
      const id = parseParam(conversationIdSchema, req.params.id, "id");
      res.json(await getGroupInfo(callerOf(req), id));
    }),
  );

  router.put(
    "/conversations/:id/group-info",
    asyncRoute(async (req, res) => {
      const id = parseParam(conversationIdSchema, req.params.id, "id");
      const body = parseBody(putGroupInfoRequestSchema, req);
      res.json(await putGroupInfo(callerOf(req), id, body));
    }),
  );

  return router;
}
