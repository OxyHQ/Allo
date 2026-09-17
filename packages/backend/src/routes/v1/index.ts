/**
 * `/v1` — the messaging platform's HTTP surface, `docs/platform/api-v1.md`.
 *
 * Mounted behind Oxy auth in `app.ts`. Which routes additionally need the
 * instance signature is decided route by route with `instanceAuth`, so the
 * Oxy-only routes (register, list own instances, another account's public
 * instances) sit in the same router as the signed ones and the reader sees the
 * auth of every route beside its handler.
 *
 * `POST /v1/blobs` is NOT here: its body is raw bytes and it must be mounted
 * ahead of the JSON parser, so `app.ts` mounts it itself.
 */

import { Router, type RequestHandler } from "express";
import { createInstanceRoutes } from "./instances";
import { createKeyPackageRoutes } from "./keyPackages";
import { createConversationRoutes } from "./conversations";
import { createEventRoutes } from "./events";
import { createSyncRoutes } from "./sync";
import { createBlobReadRoutes } from "./blobs";

export interface V1RouterDeps {
  /** `requireInstance()` from `middleware/instanceAuth.ts`, or a test double. */
  instanceAuth: RequestHandler;
}

export function createV1Router(deps: V1RouterDeps): Router {
  const router = Router();
  router.use(createInstanceRoutes(deps));
  router.use(createKeyPackageRoutes(deps));
  router.use(createConversationRoutes(deps));
  router.use(createEventRoutes(deps));
  router.use(createSyncRoutes(deps));
  router.use(createBlobReadRoutes(deps));
  return router;
}
