import express, { type Express } from "express";
import { captureRawBody } from "./middleware";
import { buildRouter } from "./routes";
import { TelegramManager } from "./telegram/manager";

/**
 * Build the connector's Express app around a shared `TelegramManager`.
 *
 * Body parsing mirrors Allo's backend: a json parser with a `verify` hook
 * captures the RAW request bytes so the HMAC is computed over exactly what Allo
 * signed (key ordering / whitespace in a re-serialization would differ). The
 * capture is mounted app-wide here because every signed route on the connector is
 * JSON (unlike the backend, which scopes it to `/internal/bridge` to coexist with
 * a multipart media route — the connector has no inbound multipart endpoint).
 *
 * Separated from `index.ts` so tests can build the app without binding a port or
 * connecting to Mongo.
 */
export function buildApp(manager: TelegramManager): Express {
  const app = express();
  // Reasonable cap; bridge command/session bodies are tiny JSON.
  app.use(express.json({ verify: captureRawBody, limit: "1mb" }));
  app.use(buildRouter(manager));
  return app;
}
