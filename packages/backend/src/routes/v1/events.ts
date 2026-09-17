import { Router, type RequestHandler } from "express";
import { conversationIdSchema, listEventsQuerySchema, submitEventRequestSchema } from "@allo/shared-types";
import { listConversationEvents, submitEvent } from "../../services/platform/eventService";
import { asyncRoute } from "./asyncRoute";
import { callerOf } from "./conversations";
import { parseBody, parseParam, parseQuery } from "./validate";

/**
 * The event log. The body is `SubmitEventRequest`: an idempotency key, a kind,
 * an epoch, a base64 `payload` the server never decodes, optional commit info
 * and blob ids. There is no text, body or content field to read, and the
 * source-scan gate `__tests__/platform/noPlaintextPaths.test.ts` keeps it so.
 */
export function createEventRoutes(deps: { instanceAuth: RequestHandler }): Router {
  const router = Router();
  router.use("/conversations/:id/events", deps.instanceAuth);

  router.post(
    "/conversations/:id/events",
    asyncRoute(async (req, res) => {
      const id = parseParam(conversationIdSchema, req.params.id, "id");
      const body = parseBody(submitEventRequestSchema, req);
      res.status(200).json(await submitEvent(callerOf(req), id, body));
    }),
  );

  router.get(
    "/conversations/:id/events",
    asyncRoute(async (req, res) => {
      const id = parseParam(conversationIdSchema, req.params.id, "id");
      const query = parseQuery(listEventsQuerySchema, req);
      res.json(await listConversationEvents(callerOf(req), id, query));
    }),
  );

  return router;
}
