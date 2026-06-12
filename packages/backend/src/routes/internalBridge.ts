import { Router, Request, Response } from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import type { BridgeEvent } from "@allo/shared-types";
import { isNetwork } from "@allo/shared-types";
import { sendErrorResponse, sendSuccessResponse } from "../utils/apiHelpers";
import { logger } from "../utils/logger";
import {
  UPLOAD_DIR,
  UPLOAD_MAX_FILE_SIZE,
  DANGEROUS_EXTENSIONS,
  buildSafeStoredFilename,
  isAllowedMime,
} from "../config/uploads";
import { bridgeAuth, bridgeMediaAuth } from "../middleware/bridgeAuth";
import * as BridgeInboundService from "../services/BridgeInboundService";

/**
 * Internal bridge routes — consumed ONLY by the bridge connector service. NOT
 * under Oxy auth: the connector authenticates by HMAC signature, applied PER
 * ROUTE here (not as a blanket mount middleware) because the two routes sign
 * different canonical strings:
 *   - `POST /events` (JSON) -> `bridgeAuth`: signs method+path+timestamp+body.
 *   - `POST /media` (multipart) -> `bridgeMediaAuth`: signs method+path+timestamp
 *     only (the multipart body is streamed into multer and never buffered for
 *     HMAC). A blanket `bridgeAuth` mount would 400 every `/media` upload because
 *     the raw body is never captured for multipart.
 *
 * Mounted at `/internal/bridge` in server.ts (with the scoped raw-body json
 * parser ahead of it so `/events` still gets `req.rawBody`).
 */

const router = Router();

// Ensure the uploads dir exists (same fallback dir as the messages upload).
try {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
} catch (err) {
  logger.error("Failed to create uploads directory for bridge media", err);
}

// Multer config replicated from routes/messages.ts (lines ~143-165) with
// IDENTICAL security properties: MIME allowlist, extension blocklist, and a
// stored filename whose extension is re-derived from the validated MIME (never
// the client filename). Replicated rather than extracted to keep the existing
// messages upload path completely untouched (zero-risk).
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      cb(null, buildSafeStoredFilename(file.originalname, file.mimetype));
    },
  }),
  limits: { fileSize: UPLOAD_MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (DANGEROUS_EXTENSIONS.has(ext)) {
      cb(new Error("File type not allowed"));
      return;
    }
    if (!isAllowedMime(file.mimetype)) {
      cb(new Error("File type not allowed"));
      return;
    }
    cb(null, true);
  },
});

/** Run multer's single-file middleware, mapping filter/limit errors to 400. */
const uploadSingleFile = (req: Request, res: Response, next: () => void) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      sendErrorResponse(res, 400, "Bad Request", message);
      return;
    }
    next();
  });
};

const EVENT_TYPES = new Set<BridgeEvent["type"]>([
  "message",
  "edit",
  "delete",
  "send_result",
  "session_status",
]);

/**
 * Validate the SHAPE of an inbound event (not its business semantics). Returns an
 * error string when malformed, or null when the shape is acceptable. Genuine
 * malformed shapes are the only thing the route rejects with 400; processing
 * errors are caught inside the service so we still return 200 (no connector retry
 * of a poison event).
 */
function validateEventShape(body: unknown): string | null {
  if (!body || typeof body !== "object") return "Body must be an object";
  const e = body as Partial<BridgeEvent>;
  if (e.v !== 1) return "Unsupported or missing protocol version";
  if (typeof e.type !== "string" || !EVENT_TYPES.has(e.type)) return "Invalid event type";
  if (!isNetwork(e.network)) return "Invalid or missing network";
  if (typeof e.ownerUserId !== "string" || e.ownerUserId.length === 0) {
    return "Missing ownerUserId";
  }
  if (typeof e.externalChatId !== "string" || e.externalChatId.length === 0) {
    return "Missing externalChatId";
  }

  switch (e.type) {
    case "message": {
      if (typeof e.externalSenderId !== "string" || e.externalSenderId.length === 0) {
        return "message requires externalSenderId";
      }
      if (typeof e.externalMessageId !== "string" || e.externalMessageId.length === 0) {
        return "message requires externalMessageId";
      }
      const hasText = typeof e.text === "string" && e.text.length > 0;
      const hasMedia = Array.isArray(e.media) && e.media.length > 0;
      if (!hasText && !hasMedia) return "message requires text or media";
      return null;
    }
    case "edit":
    case "delete": {
      if (typeof e.externalMessageId !== "string" || e.externalMessageId.length === 0) {
        return `${e.type} requires externalMessageId`;
      }
      return null;
    }
    case "send_result": {
      const hasCorrelation =
        (typeof e.messageId === "string" && e.messageId.length > 0) ||
        (typeof e.clientMessageId === "string" && e.clientMessageId.length > 0);
      if (!hasCorrelation) return "send_result requires messageId or clientMessageId";
      if (e.status !== "sent" && e.status !== "failed") return "send_result requires a status";
      return null;
    }
    case "session_status": {
      const ok =
        e.sessionStatus === "active" ||
        e.sessionStatus === "expired" ||
        e.sessionStatus === "revoked" ||
        e.sessionStatus === "error";
      if (!ok) return "session_status requires a valid sessionStatus";
      return null;
    }
    default:
      return "Invalid event type";
  }
}

/**
 * POST /internal/bridge/events
 * Receive a single BridgeEvent from the connector. Malformed shapes -> 400.
 * Well-formed events are handed to the inbound service, which swallows its own
 * processing errors, so this route returns 200 on any well-formed event.
 */
router.post("/events", bridgeAuth, async (req: Request, res: Response) => {
  const shapeError = validateEventShape(req.body);
  if (shapeError) {
    return sendErrorResponse(res, 400, "Bad Request", shapeError);
  }
  const event = req.body as BridgeEvent;
  await BridgeInboundService.handleEvent(event);
  return sendSuccessResponse(res, 200, { ok: true });
});

/**
 * POST /internal/bridge/media
 * Re-host external media on Allo's domain so it can be referenced by URL in a
 * subsequent `message` event. Same response shape as POST /api/messages/upload.
 */
router.post("/media", bridgeMediaAuth, uploadSingleFile, (req: Request, res: Response) => {
  const file = req.file;
  if (!file) {
    return sendErrorResponse(res, 400, "Bad Request", "No file uploaded");
  }
  return sendSuccessResponse(res, 201, {
    id: file.filename,
    url: `/uploads/${file.filename}`,
    fileName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
  });
});

export default router;
