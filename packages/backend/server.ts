/**
 * Bootstrap only. Assembly is `src/app.ts` (pure) and `src/runtimeApp.ts`
 * (concrete deps); this file installs the process handlers, boots in the
 * order below, and registers the drain.
 *
 *   validate env → not ready → connect Postgres (and prove it) →
 *   (production) assert the migration ledger is current → migrations complete →
 *   Socket.IO (+ Redis adapter, optional) → workers → listen → READY.
 *
 * Anything failing before `listen` marks `boot_failed` and exits 1.
 */

import dotenv from "dotenv";
import http from "node:http";
import { join } from "node:path";
import { assertPostgresMigrationsCurrent, readJournal } from "@oxy.so/db/migrate";
import { startEcosystemActivity, stopEcosystemActivity } from "./src/ecosystemActivity";
import { checkPostgresHealth, closePostgres, connectPostgres, getDb, getPostgresClient } from "./src/db";
import { startExpirySweep, stopExpirySweep } from "./src/db/expiry";
import { registerGlobalErrorHandlers } from "./src/runtime/globalErrorHandlers";
import { registerGracefulShutdown } from "./src/runtime/gracefulShutdown";
import { markMigrationsComplete, markRuntimeNotReady, markRuntimeReady } from "./src/runtime/health";
import { setRealtime } from "./src/runtime/realtime";
import { createSocketServer } from "./src/runtime/socket";
import { attachSocketRedisAdapter } from "./src/runtime/socketRedisAdapter";
import { createRuntimeApp } from "./src/runtimeApp";
import { startModerationOutboxDispatcher, stopModerationOutboxDispatcher } from "./src/services/moderation/ModerationOutboxDispatcher";
import { blobMaxBytes } from "./src/services/platform/blobService";
import { logger } from "./src/utils/logger";
import { startBlobGc, stopBlobGc } from "./src/workers/blobGc";
import { startDeliveryWorker, stopDeliveryWorker } from "./src/workers/deliveryWorker";

dotenv.config();
registerGlobalErrorHandlers();

export { APP_ORIGINS } from "./src/app";

/** Everything read from the environment at boot, validated before anything opens a socket. */
function validateEnvironment(): { databaseUrl: string; port: number } {
  const url = process.env.DATABASE_URL;
  if (!url || url.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is not set. Every route in this service runs on Postgres and cannot answer without it.",
    );
  }
  blobMaxBytes();
  // Local dev default only — ECS injects PORT (8080). 4140 is Allo's slot in the per-app port map.
  const port = Number(process.env.PORT ?? 4140);
  if (!Number.isInteger(port) || port < 1) throw new Error("PORT must be a positive integer");
  return { databaseUrl: url, port };
}

const { app, oxy } = createRuntimeApp();
const server = http.createServer(app);

async function stopWorkers(): Promise<void> {
  stopExpirySweep();
  stopModerationOutboxDispatcher();
  await Promise.allSettled([stopDeliveryWorker(), stopBlobGc()]);
}

export async function bootServer(): Promise<void> {
  markRuntimeNotReady("booting");
  try {
    const env = validateEnvironment();
    const db = connectPostgres(env.databaseUrl);
    if (!(await checkPostgresHealth())) throw new Error("Postgres is unreachable");
    if (process.env.NODE_ENV === "production") {
      await assertPostgresMigrationsCurrent(getPostgresClient(), readJournal(join(__dirname, "drizzle")));
    }
    markMigrationsComplete();

    const sockets = createSocketServer(server, { oxy });
    setRealtime(sockets.realtime);
    await attachSocketRedisAdapter(sockets.io);

    startEcosystemActivity(() => server.listening);
    startExpirySweep(getDb(), logger);
    startModerationOutboxDispatcher();
    startDeliveryWorker({ db });
    startBlobGc({ db });

    registerGracefulShutdown({
      server,
      io: sockets.io,
      stopWorkers,
      closePostgres,
      stopActivity: stopEcosystemActivity,
    });

    await new Promise<void>((resolve) => server.listen(env.port, resolve));
    markRuntimeReady();
    logger.info("Allo backend listening", { port: env.port });
  } catch (error) {
    markRuntimeNotReady("boot_failed");
    logger.error("Failed to start server", error);
    process.exit(1);
  }
}

if (require.main === module) {
  void bootServer();
}

export { app };
export default server;
