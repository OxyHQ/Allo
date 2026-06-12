import http from "http";
import mongoose from "mongoose";
import { buildApp } from "./app";
import { TelegramManager } from "./telegram/manager";
import { sendDeduplicator } from "./sendDedup";
import { logger } from "./logger";
import {
  getBridgePort,
  getBridgeMongoUri,
  getBridgeDbName,
  getBridgeSharedSecret,
  getBridgeSessionKey,
  isBridgeEnabled,
  LOGIN_ATTEMPT_TTL_MS,
} from "./config";

/**
 * Connector entrypoint. Boots Mongo (its OWN database, separate from Allo's),
 * starts the HTTP server, and installs graceful shutdown.
 *
 * Boot is deliberately tolerant: the connector starts and serves `/healthz` even
 * when Telegram credentials are absent (session ops then return 503). It refuses
 * to start only when its OWN security invariants are unmet (bridge disabled, or
 * the HMAC secret / session-encryption key missing-or-too-short) — running
 * without those would either be a no-op or store credentials insecurely.
 */

/** How often stale (abandoned) login attempts are pruned. */
const LOGIN_PRUNE_INTERVAL_MS = LOGIN_ATTEMPT_TTL_MS;

async function main(): Promise<void> {
  if (!isBridgeEnabled()) {
    logger.error("BRIDGE_ENABLED is not 'true'; refusing to start the connector");
    process.exit(1);
    return;
  }
  if (!getBridgeSharedSecret()) {
    logger.error(
      "BRIDGE_SHARED_SECRET is missing or shorter than 32 chars; refusing to start (every signed request would fail)"
    );
    process.exit(1);
    return;
  }
  if (!getBridgeSessionKey()) {
    logger.error(
      "BRIDGE_SESSION_KEY is missing or shorter than 32 chars; refusing to start (sessions could not be encrypted at rest)"
    );
    process.exit(1);
    return;
  }

  const mongoUri = getBridgeMongoUri();
  if (!mongoUri) {
    logger.error("BRIDGE_MONGODB_URI (or MONGODB_URI) is not set; refusing to start");
    process.exit(1);
    return;
  }

  await mongoose.connect(mongoUri, { dbName: getBridgeDbName() });
  logger.info(`Connector connected to Mongo (db: ${getBridgeDbName()})`);

  const manager = new TelegramManager();
  if (!manager.isConfigured()) {
    logger.warn(
      "TELEGRAM_API_ID / TELEGRAM_API_HASH not configured; Telegram session operations will return 503 until provisioned"
    );
  }

  const app = buildApp(manager);
  const server = http.createServer(app);
  const port = getBridgePort();

  const pruneTimer = setInterval(() => {
    manager.pruneStaleLogins();
  }, LOGIN_PRUNE_INTERVAL_MS);
  // Don't keep the process alive solely for the prune timer.
  pruneTimer.unref();

  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      logger.info(`Allo bridge connector listening on port ${port}`);
      resolve();
    });
  });

  installGracefulShutdown(server, manager, pruneTimer);
}

/** Wire SIGINT/SIGTERM to drain the server, disconnect clients, and close Mongo. */
function installGracefulShutdown(
  server: http.Server,
  manager: TelegramManager,
  pruneTimer: ReturnType<typeof setInterval>
): void {
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}; shutting down gracefully`);
    clearInterval(pruneTimer);
    // Stop accepting/draining requests first so any in-flight send completes;
    // then release the (timer-less) dedup state and tear down clients + Mongo.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    sendDeduplicator.clear();
    await manager.shutdown();
    await mongoose.disconnect();
    logger.info("Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  logger.error("Connector failed to start", error as Error);
  process.exit(1);
});
