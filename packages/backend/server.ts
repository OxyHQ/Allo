import { startEcosystemActivity, stopEcosystemActivity, ecosystemActivityMiddleware } from './src/ecosystemActivity';
// --- Imports ---
import express from "express";
import http from "http";
import dotenv from "dotenv";
import { oxyClient } from "@oxy.so/core";
import { createOxyAuthMiddleware, createOxyCors, createOxyRateLimit } from "@oxy.so/core/server";
import { logger } from "./src/utils/logger";
import { closePostgres, connectPostgres, ensurePostgresReachable } from "./src/db";
import { startExpirySweep, stopExpirySweep } from "./src/db/expiry";

// Routers
import profileSettingsRoutes from "./src/routes/profileSettings";
import reportsRoutes from "./src/routes/reports";
import { createCrowdSourceWebhookRoutes } from "./src/routes/crowdSourceWebhook";
import { createDirectoryRoutes } from "./src/routes/directory";
import { createOxyDirectoryService } from "./src/services/oxy/OxyDirectoryService";
import { configureOxyServiceAuth } from "./src/config/oxyService";
import { startModerationOutboxDispatcher, stopModerationOutboxDispatcher } from "./src/services/moderation/ModerationOutboxDispatcher";

// --- Config ---
dotenv.config();

// Origins that are NOT covered by createOxyCors, which admits the Oxy apex
// family (*.oxy.so) automatically and nothing else.
//
// `https://allo.you` has to be listed explicitly for exactly that reason: it is
// the product's own domain, outside the oxy.so apex, so the automatic rule does
// not reach it. Dropping it from here does not fail at boot — it fails in the
// browser, as a CORS error on every request the web app makes.
//
// Exported so the realtime layer, which is mounted on the same `server` below,
// can reuse the one allowlist rather than carry a second copy that drifts.
export const APP_ORIGINS = [
  "https://allo.you",
  "http://localhost:8140",
  "http://localhost:8141",
];

const app = express();
app.use(ecosystemActivityMiddleware);

// Initialize Oxy client for authentication
export const oxy = oxyClient;

/**
 * The same client, additionally configured to call Oxy AS ALLO when a service
 * credential is present.
 *
 * A no-op without one, and the directory still works — every Oxy route it uses
 * is public. See `src/config/oxyService.ts` for what a credential changes and
 * for the human step that mints it.
 */
configureOxyServiceAuth(oxy);

// --- Middleware ---

/**
 * MUST stay ahead of `express.json` below.
 *
 * A CrowdSource webhook signature covers the bytes that arrived, and once a JSON
 * parser has consumed the stream those bytes no longer exist.
 * `@oxy.so/crowdsource-express` reads the raw stream itself and REFUSES if
 * something upstream already consumed it, rather than verifying a signature over a
 * re-serialisation — so mounting this after the parser does not silently verify
 * the wrong bytes, it fails every delivery. The route adds its own assertion on top
 * of that (see `assertRawBody`), which names the mount order as the cause instead
 * of leaving a signature mismatch to be misread as a bad secret.
 *
 * It also sits ahead of the per-user rate limiter further down, deliberately: the
 * HMAC is the authentication (§10.8), and a 429 to CrowdSource would put a
 * moderation decision back on a retry schedule for no reason.
 */
app.use("/webhooks", createCrowdSourceWebhookRoutes());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Database availability, at cold start only.
 *
 * `ensurePostgresReachable()` probes ONCE and caches the result, so this costs
 * a round trip on the first request after boot and nothing on every request
 * after it. A database that dies mid-life is NOT covered here — that is a 500
 * from whichever handler touches it. See `src/db/index.ts` for why it is
 * deliberately not a per-request check.
 */
app.use(async (req, res, next) => {
  try {
    await ensurePostgresReachable();
    next();
  } catch (error) {
    logger.error("Postgres connection unavailable", error);
    if (res.headersSent) {
      return;
    }
    res.status(503).json({ message: "Database temporarily unavailable" });
  }
});

// Strict CORS allowlist (Oxy apex family + explicit dev origins). Echoes back
// the exact matched origin, never a credentialed wildcard, and answers OPTIONS
// preflight with 204.
app.use(createOxyCors({ appOrigins: APP_ORIGINS }));

// No-store cache headers for all API responses (not CORS-related).
app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

/**
 * The one HTTP server. The messaging platform's realtime layer attaches to this
 * same server (see `docs/platform/api-v1.md`); it is created here, ahead of the
 * routers, so that attachment has something to bind to before anything listens.
 */
const server = http.createServer(app);

// Resolve session and apply per-user rate limiting in one shared middleware.
app.use(createOxyRateLimit(oxy));

// --- API ROUTES ---
// Public API routes (no authentication required)
const publicApiRouter = express.Router();

// Health check
publicApiRouter.get("/health", (req, res) => {
  res.json({ status: "ok", service: "allo-backend" });
});

// Authenticated API routes (require authentication)
const authenticatedApiRouter = express.Router();
authenticatedApiRouter.use("/profile", profileSettingsRoutes);
authenticatedApiRouter.use("/reports", reportsRoutes);
authenticatedApiRouter.use("/directory", createDirectoryRoutes({ service: createOxyDirectoryService(oxy) }));

// Mount public and authenticated API routers
app.use("/api", publicApiRouter);

/**
 * One way to be signed in: an Oxy access token, `Authorization: Bearer`.
 * `createOxyAuthMiddleware` produces `req.userId` / `req.user` for every route
 * behind it.
 */
app.use("/api", createOxyAuthMiddleware(oxy), authenticatedApiRouter);

// --- Root API Welcome Route ---
app.get("/", async (req, res) => {
  res.json({ message: "Welcome to Allo API", version: "1.0.0" });
});

/**
 * The Postgres connection string. REQUIRED — this service stores everything it
 * owns there and no route can answer without it.
 *
 * Read and validated at boot rather than on first use, so a deployment with a
 * missing or malformed URL dies immediately and visibly instead of serving 500s
 * from whichever endpoint a user happens to hit first.
 */
function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is not set. Every route in this service runs on Postgres and " +
        "cannot answer without it.",
    );
  }
  return url;
}

// --- Server Listen ---
// Local dev default only — ECS injects PORT explicitly (oxy-infra
// terraform-uswest2/app-allo.tf sets it to 8080). 4140 is Allo's slot in the
// per-app port map so several Oxy backends can run side by side.
const PORT = process.env.PORT || 4140;
const bootServer = async () => {
  startEcosystemActivity(() => server.listening);
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    stopExpirySweep();
    stopModerationOutboxDispatcher();
    server.close(() => {
      void stopEcosystemActivity().finally(() => closePostgres()).catch(() => {
        logger.error('Failed to close activity publisher or database');
        process.exitCode = 1;
      });
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    /**
     * Postgres first, and not lazily: `createDatabase` opens the pool here so a
     * bad connection string fails the boot rather than the first request that
     * happens to touch a table.
     */
    const postgres = connectPostgres(requireDatabaseUrl());
    /**
     * The TTL replacement (`db/expiry.ts`). Started here because a registry
     * nothing schedules reaps nothing, and that omission is invisible until a
     * table has grown for months.
     */
    startExpirySweep(postgres, logger);
    // Started after the pool is open: the dispatcher's first act is a claim
    // query, and a drain with nothing to query would only log noise.
    // A no-op unless CROWDSOURCE_ENABLED=true.
    startModerationOutboxDispatcher();
    server.listen(PORT, () => {
      logger.info(`Allo backend server running on port ${PORT}`);
    });
  } catch (error) {
    logger.error("Failed to start server: the database is unreachable or misconfigured", error);
    process.exit(1);
  }
};

if (require.main === module) {
  void bootServer();
}

export { app };
export default server;
