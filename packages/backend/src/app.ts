/**
 * `createApp(deps)` — pure HTTP assembly. No I/O: it never listens, never
 * opens Postgres, never creates a Socket.IO server, never starts a timer.
 * `runtimeApp.ts` builds the concrete deps; tests build fakes.
 *
 * The ORDER below is the contract:
 *
 *   1. request observability (request id + route template log)
 *   2. ecosystem activity observer (a no-op until boot starts it)
 *   3. CORS (`createOxyCors`, plus `APP_ORIGINS`)
 *   4. `/health/live`, `/health/ready`, `/api/health` (alias of ready)
 *   5. RAW-BODY routes, ahead of the JSON parser:
 *        `/webhooks` (CrowdSource verifies the bytes that arrived)
 *        `POST /v1/blobs` (octet-stream, size-capped, signature over the bytes)
 *   6. `express.json({ verify })` capturing `req.rawBody` for the signature
 *   7. no-store headers
 *   8. per-user rate limit
 *   9. `/api/*` behind Oxy auth (profile, reports, directory)
 *      `/v1/*` behind Oxy auth, instance signature per route
 *  10. JSON 404
 *  11. the one error handler: zod → 400 `validation_failed`, `AlloHttpError`
 *      → its code, body-parser's 413 → `payload_too_large`, its 400s →
 *      `validation_failed`, everything else → 500 `internal` with NO message.
 */

import express, { type ErrorRequestHandler, type Express, type RequestHandler, type Router } from "express";
import { ZodError } from "zod";
import { errorResponseSchema, type AlloErrorCode } from "@allo/shared-types";
import { requestObservability } from "./middleware/requestObservability";
import { getRuntimeHealthState } from "./runtime/health";
import { createBlobBodyParser, createBlobUploadHandler } from "./routes/v1/blobs";
import { createV1Router } from "./routes/v1";
import { AlloHttpError, STATUS_BY_CODE } from "./utils/httpErrors";
import { logger } from "./utils/logger";

/**
 * Origins that are NOT covered by createOxyCors, which admits the Oxy apex
 * family (*.oxy.so) automatically and nothing else. `https://allo.you` is the
 * product's own domain and has to be listed. Dropping it fails in the browser,
 * not at boot.
 */
export const APP_ORIGINS = ["https://allo.you", "http://localhost:8140", "http://localhost:8141"];

/** JSON bodies: an event payload is up to 1 MiB of base64 and a create may carry two. */
export const JSON_BODY_LIMIT = "4mb";

export interface CreateAppDependencies {
  /** Oxy bearer auth for `/api`: sets `req.userId`, answers Oxy's own envelope. */
  auth: RequestHandler;
  /**
   * Oxy auth for `/v1`: the chain that ends in the contract's `unauthorized`
   * envelope (`createOptionalOxyAuth` then `requireOxySession`). Defaults to
   * `[auth]`, which is what a test double wants.
   */
  v1Auth?: RequestHandler[];
  /** The per-route instance signature check. */
  instanceAuth: RequestHandler;
  rateLimit: RequestHandler;
  cors: RequestHandler;
  /** Observes traffic for the Oxy ecosystem dashboard; identity when disabled. */
  ecosystemActivity?: RequestHandler;
  /** `/webhooks/*` — mounted raw. */
  webhooks: Router;
  /** The kept `/api/*` routers, mounted behind Oxy auth. */
  api: { profile: Router; reports: Router; directory: Router };
  /** `select 1` against the pool; false when it cannot be reached. */
  checkPostgres: () => Promise<boolean>;
  blobMaxBytes: number;
}

function healthRoutes(checkPostgres: () => Promise<boolean>): Router {
  const router = express.Router();
  router.get("/health/live", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ status: "alive" });
  });
  const ready: RequestHandler = (_req, res) => {
    void (async () => {
      const runtime = getRuntimeHealthState();
      const postgres = await checkPostgres().catch(() => false);
      const ok = runtime.phase === "ready" && runtime.migrationsComplete && postgres;
      res.setHeader("Cache-Control", "no-store");
      res.status(ok ? 200 : 503).json({
        status: ok ? "ready" : "not_ready",
        phase: runtime.phase,
        dependencies: {
          postgres: postgres ? "ready" : "unavailable",
          migrations: runtime.migrationsComplete ? "ready" : "pending",
        },
      });
    })();
  };
  router.get("/health/ready", ready);
  router.get("/api/health", ready);
  return router;
}

/** body-parser's errors carry `type`; these are the ones a client caused. */
function bodyParserCode(error: unknown): AlloErrorCode | null {
  if (typeof error !== "object" || error === null) return null;
  const type = Reflect.get(error, "type");
  if (type === "entity.too.large") return "payload_too_large";
  if (typeof type === "string" && (type.startsWith("entity.") || type === "encoding.unsupported" || type === "charset.unsupported")) {
    return "validation_failed";
  }
  return null;
}

export function createErrorHandler(): ErrorRequestHandler {
  return (error: unknown, _req, res, _next) => {
    let code: AlloErrorCode;
    let message: string;
    let details: unknown;
    if (error instanceof AlloHttpError) {
      ({ code, message, details } = error);
    } else if (error instanceof ZodError) {
      code = "validation_failed";
      message = "The request did not satisfy its schema";
      details = error.issues;
    } else if (bodyParserCode(error) !== null) {
      code = bodyParserCode(error) as AlloErrorCode;
      message = code === "payload_too_large" ? "The body is larger than allowed" : "The body could not be parsed";
    } else {
      code = "internal";
      message = "Internal error";
      logger.error("Unhandled request error", error);
    }
    const body = errorResponseSchema.parse({ error: { code, message, ...(details === undefined ? {} : { details }) } });
    if (res.headersSent) return;
    res.status(STATUS_BY_CODE[code]).json(body);
  };
}

export function createApp(deps: CreateAppDependencies): Express {
  const app = express();
  app.disable("x-powered-by");

  app.use(requestObservability);
  if (deps.ecosystemActivity) app.use(deps.ecosystemActivity);
  app.use(deps.cors);
  app.use(healthRoutes(deps.checkPostgres));

  // Raw-body routes, BEFORE the JSON parser.
  app.use("/webhooks", deps.webhooks);
  app.post(
    "/v1/blobs",
    deps.rateLimit,
    ...(deps.v1Auth ?? [deps.auth]),
    createBlobBodyParser(deps.blobMaxBytes),
    deps.instanceAuth,
    createBlobUploadHandler({ maxBytes: deps.blobMaxBytes }),
  );

  app.use(
    express.json({
      limit: JSON_BODY_LIMIT,
      verify: (req, _res, buf) => {
        Reflect.set(req, "rawBody", buf);
      },
    }),
  );

  app.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    next();
  });

  app.use(deps.rateLimit);

  const api = express.Router();
  api.use("/profile", deps.api.profile);
  api.use("/reports", deps.api.reports);
  api.use("/directory", deps.api.directory);
  app.use("/api", deps.auth, api);

  app.use("/v1", ...(deps.v1Auth ?? [deps.auth]), createV1Router({ instanceAuth: deps.instanceAuth }));

  app.get("/", (_req, res) => {
    res.json({ message: "Welcome to Allo API", version: "1.0.0" });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "No such route" } });
  });

  app.use(createErrorHandler());
  return app;
}
