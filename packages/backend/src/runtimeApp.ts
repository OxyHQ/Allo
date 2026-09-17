/**
 * The only place concrete dependencies are constructed: the Oxy client, its
 * CORS, rate limit and auth middlewares, the instance signature check, the
 * kept `/api` routers and the CrowdSource webhook. `createApp` is handed the
 * result; `server.ts` listens.
 */

import { oxyClient } from "@oxy.so/core";
import { createOptionalOxyAuth, createOxyAuthMiddleware, createOxyCors, createOxyRateLimit } from "@oxy.so/core/server";
import { APP_ORIGINS, createApp } from "./app";
import { configureOxyServiceAuth } from "./config/oxyService";
import { checkPostgresHealth } from "./db";
import { ecosystemActivityMiddleware } from "./ecosystemActivity";
import { requireInstance } from "./middleware/instanceAuth";
import { requireOxySession } from "./middleware/oxySession";
import { createCrowdSourceWebhookRoutes } from "./routes/crowdSourceWebhook";
import { createDirectoryRoutes } from "./routes/directory";
import profileSettingsRoutes from "./routes/profileSettings";
import reportsRoutes from "./routes/reports";
import { createOxyDirectoryService } from "./services/oxy/OxyDirectoryService";
import { blobMaxBytes } from "./services/platform/blobService";

export function createRuntimeApp() {
  const oxy = oxyClient;
  configureOxyServiceAuth(oxy);
  const app = createApp({
    auth: createOxyAuthMiddleware(oxy),
    v1Auth: [createOptionalOxyAuth(oxy), requireOxySession],
    instanceAuth: requireInstance(),
    rateLimit: createOxyRateLimit(oxy),
    cors: createOxyCors({ appOrigins: APP_ORIGINS }),
    ecosystemActivity: ecosystemActivityMiddleware,
    webhooks: createCrowdSourceWebhookRoutes(),
    api: {
      profile: profileSettingsRoutes,
      reports: reportsRoutes,
      directory: createDirectoryRoutes({ service: createOxyDirectoryService(oxy) }),
    },
    checkPostgres: checkPostgresHealth,
    blobMaxBytes: blobMaxBytes(),
  });
  return { app, oxy };
}
