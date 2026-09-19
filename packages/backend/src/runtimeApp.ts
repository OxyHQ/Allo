/**
 * The only place concrete dependencies are constructed: the Oxy client, its
 * CORS, rate limit and auth middlewares, the instance signature check, the
 * kept `/api` routers and the CrowdSource webhook. `createApp` is handed the
 * result; `server.ts` listens.
 */

import { oxyClient } from "@oxy.so/core";
import { createOptionalOxyAuth, createOxyAuthMiddleware, createOxyCors, createOxyRateLimit } from "@oxy.so/core/server";
import { APP_ORIGINS, createApp } from "./app";
import { setIceConfig } from "./config/iceRuntime";
import { readLiveKitConfig } from "./config/livekit";
import { configureOxyServiceAuth } from "./config/oxyService";
import { setLiveKitConfig } from "./config/sfuRuntime";
import { readIceConfig } from "./config/turn";
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
  /**
   * The media configuration is read HERE, once, so a half-configured relay or
   * SFU fails the boot rather than the first call — which is what both config
   * modules promised and neither got, because nothing called them. Left
   * unread, `getIceConfig()` fell back to parsing an empty environment: every
   * deployment served STUN alone, `TURN_URLS` was dead, and a call that hid an
   * address was told `relayOnly` with nowhere to relay, so it could not
   * connect at all.
   */
  setIceConfig(readIceConfig());
  setLiveKitConfig(readLiveKitConfig());
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
