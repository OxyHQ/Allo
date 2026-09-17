/**
 * The SIGTERM/SIGINT drain, 10 s deadline.
 *
 * 1. readiness drops FIRST (the load balancer stops routing here);
 * 2. HTTP stops accepting; the hard timeout is armed;
 * 3. sockets close;
 * 4. phase A — producers and workers stop while Postgres is still open;
 * 5. phase B — HTTP, sockets, the Redis adapter, the activity publisher and
 *    Postgres close together;
 * 6. exit 0. The deadline forces open connections closed and exits 1.
 */

import type http from "node:http";
import type { Server as SocketIOServer } from "socket.io";
import { logger } from "../utils/logger";
import { markRuntimeShuttingDown } from "./health";
import { clearRealtime } from "./realtime";
import { closeSocketRedisAdapter } from "./socketRedisAdapter";

export const SHUTDOWN_DEADLINE_MS = 10_000;

export interface GracefulShutdownDeps {
  server: http.Server;
  io?: SocketIOServer;
  /** Phase A: everything that writes or emits. */
  stopWorkers: () => Promise<void>;
  /** Phase B. */
  closePostgres: () => Promise<void>;
  stopActivity?: () => Promise<void>;
  exit?: (code: number) => void;
}

export function registerGracefulShutdown(deps: GracefulShutdownDeps): () => void {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    markRuntimeShuttingDown();
    logger.info(`Received ${signal} - shutting down gracefully`);

    const httpClosed = new Promise<void>((resolve) => {
      if (!deps.server.listening) return resolve();
      deps.server.close((error) => {
        if (error) logger.warn("HTTP server close reported an error", error);
        resolve();
      });
    });
    const hardTimeout = setTimeout(() => {
      logger.warn("Shutdown timed out - forcing open connections closed");
      deps.server.closeAllConnections?.();
      exit(1);
    }, SHUTDOWN_DEADLINE_MS);
    hardTimeout.unref();

    void (async () => {
      const socketsClosed = new Promise<void>((resolve) => {
        if (!deps.io) return resolve();
        deps.io.close(() => {
          clearRealtime();
          resolve();
        });
      });
      await Promise.allSettled([deps.stopWorkers()]);
      await Promise.allSettled([
        httpClosed,
        socketsClosed,
        closeSocketRedisAdapter(),
        deps.stopActivity?.() ?? Promise.resolve(),
        deps.closePostgres(),
      ]);
      clearTimeout(hardTimeout);
      logger.info("HTTP, sockets, Redis and PostgreSQL closed");
      exit(0);
    })();
  };

  const onTerm = () => shutdown("SIGTERM");
  const onInt = () => shutdown("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  return () => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  };
}
