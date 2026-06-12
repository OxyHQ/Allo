import { Router, type Request, type Response } from "express";
import type { BridgeCommand } from "@allo/shared-types";
import { verifyAlloRequest } from "./middleware";
import { admitCommand, executeCommand } from "./commandHandler";
import { TelegramManager, TelegramNotConfiguredError } from "./telegram/manager";
import * as sessionStore from "./sessionStore";
import { logger } from "./logger";

/**
 * The connector's HTTP surface.
 *
 * Signed (HMAC-verified) routes — the path each one is mounted at MUST match the
 * exact relative path Allo's backend signs and POSTs to (see `middleware.ts`):
 *   POST /commands
 *   POST /sessions/telegram/link
 *   POST /sessions/telegram/link/code
 *   POST /sessions/telegram/link/password
 *   POST /sessions/telegram/logout
 *
 * Unsigned routes:
 *   GET  /sessions/telegram/status?userId=   (ops/debug; reads local state only)
 *   GET  /healthz                            (liveness; never authenticated)
 */

/** Telegram-specific link sub-paths under `/sessions/telegram`. */
const TELEGRAM = "telegram";

/** Build the router around a shared TelegramManager instance. */
export function buildRouter(manager: TelegramManager): Router {
  const router = Router();

  // --- Liveness (no auth, no body) --------------------------------------------
  router.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true, telegramConfigured: manager.isConfigured() });
  });

  // --- Outbound commands (signed) ---------------------------------------------
  // Validate + rate-check synchronously, then execute and map the outcome to a
  // status the backend outbox understands: 2xx = handled (delivered or terminally
  // failed via send_result); 503 = retryable (e.g. a short FLOOD_WAIT) so the
  // outbox backs off and resends. `Retry-After` carries the wait hint.
  router.post("/commands", verifyAlloRequest, async (req: Request, res: Response) => {
    const command = req.body as BridgeCommand;
    if (!command || command.v !== 1 || typeof command.type !== "string") {
      res.status(400).json({ error: "invalid_command" });
      return;
    }
    const admit = admitCommand(command);
    if (!admit.accepted) {
      res.status(admit.status).json({ error: admit.reason });
      return;
    }
    try {
      const result = await executeCommand(manager, command);
      if (result.kind === "retryable") {
        if (typeof result.retryAfterSeconds === "number") {
          res.setHeader("Retry-After", String(result.retryAfterSeconds));
        }
        res.status(503).json({ error: result.reason });
        return;
      }
      res.status(200).json({ accepted: true });
    } catch (error) {
      // executeCommand never throws, but guard so the connector never 500s a
      // command into a poison-retry loop on an unexpected bug.
      logger.error("Unexpected error executing command", error as Error);
      res.status(503).json({ error: "internal_error" });
    }
  });

  // --- Session link: start (signed) -------------------------------------------
  // Allo's `POST /accounts/:network/link` proxies here with `{ ownerUserId, ... }`.
  // `phoneNumber` present => PHONE flow (send code, respond `needs_code`); absent
  // => QR flow (respond `pending` + `loginUrl`). The connector's
  // `BridgeLinkStepResult` is relayed to the client VERBATIM by the backend.
  router.post(`/sessions/${TELEGRAM}/link`, verifyAlloRequest, async (req: Request, res: Response) => {
    const { ownerUserId, phoneNumber } = req.body as {
      ownerUserId?: string;
      phoneNumber?: string;
    };
    if (!ownerUserId) {
      res.status(400).json({ error: "missing_owner" });
      return;
    }
    try {
      const step =
        typeof phoneNumber === "string" && phoneNumber.length > 0
          ? await manager.startPhoneLogin(ownerUserId, phoneNumber)
          : await manager.startQrLogin(ownerUserId);
      res.status(200).json(step);
    } catch (error) {
      handleSessionError(res, error, "Failed to start Telegram link");
    }
  });

  // --- Session link: submit code (signed) -------------------------------------
  // Body: `{ ownerUserId, code }`. Responds with the next `BridgeLinkStepResult`
  // (`active` / `needs_password` / `pending` / `error`).
  router.post(
    `/sessions/${TELEGRAM}/link/code`,
    verifyAlloRequest,
    async (req: Request, res: Response) => {
      const { ownerUserId, code } = req.body as { ownerUserId?: string; code?: string };
      if (!ownerUserId || !code) {
        res.status(400).json({ error: "missing_owner_or_code" });
        return;
      }
      try {
        const step = await manager.submitCode(ownerUserId, code);
        res.status(200).json(step);
      } catch (error) {
        handleSessionError(res, error, "Failed to submit Telegram code");
      }
    }
  );

  // --- Session link: submit 2FA password (signed) -----------------------------
  // Body: `{ ownerUserId, password }`. Responds with the next `BridgeLinkStepResult`
  // (`active` / `pending` / `error`).
  router.post(
    `/sessions/${TELEGRAM}/link/password`,
    verifyAlloRequest,
    async (req: Request, res: Response) => {
      const { ownerUserId, password } = req.body as {
        ownerUserId?: string;
        password?: string;
      };
      if (!ownerUserId || !password) {
        res.status(400).json({ error: "missing_owner_or_password" });
        return;
      }
      try {
        const step = await manager.submitPassword(ownerUserId, password);
        res.status(200).json(step);
      } catch (error) {
        handleSessionError(res, error, "Failed to submit Telegram password");
      }
    }
  );

  // --- Session logout / unlink (signed) ---------------------------------------
  // Allo's `DELETE /accounts/:network` proxies to `POST /sessions/:network/logout`.
  router.post(
    `/sessions/${TELEGRAM}/logout`,
    verifyAlloRequest,
    async (req: Request, res: Response) => {
      const { ownerUserId } = req.body as { ownerUserId?: string };
      if (!ownerUserId) {
        res.status(400).json({ error: "missing_owner" });
        return;
      }
      try {
        await manager.logout(ownerUserId);
        res.status(200).json({ status: "revoked" });
      } catch (error) {
        handleSessionError(res, error, "Failed to log out Telegram session");
      }
    }
  );

  // --- Session status (UNSIGNED; ops/debug) -----------------------------------
  // Reads the connector's local store only — no Telegram I/O, no secrets exposed.
  router.get(`/sessions/${TELEGRAM}/status`, async (req: Request, res: Response) => {
    const userId = req.query.userId;
    if (typeof userId !== "string" || userId.length === 0) {
      res.status(400).json({ error: "missing_userId" });
      return;
    }
    try {
      const status = await sessionStore.getStatus(userId);
      if (!status) {
        res.status(404).json({ error: "not_linked" });
        return;
      }
      res.status(200).json({ status, telegramConfigured: manager.isConfigured() });
    } catch (error) {
      logger.error("Failed to read Telegram session status", error as Error);
      res.status(500).json({ error: "status_failed" });
    }
  });

  return router;
}

/**
 * Map a session-operation error to an HTTP status. A missing Telegram credential
 * is the documented 503 `telegram_not_configured`; anything else is a 500. Never
 * logs request bodies.
 */
function handleSessionError(res: Response, error: unknown, context: string): void {
  if (error instanceof TelegramNotConfiguredError) {
    res.status(503).json({ error: "telegram_not_configured" });
    return;
  }
  logger.error(context, error as Error);
  res.status(500).json({ error: "session_operation_failed" });
}
