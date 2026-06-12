import type { Request, Response, NextFunction } from "express";
import {
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_TIMESTAMP_HEADER,
  isBridgeEnabled,
} from "./config";
import { verifyInboundJson } from "./signing";
import { logger } from "./logger";

/**
 * Express middleware mirroring Allo's `middleware/bridgeAuth.ts`, but for the
 * INBOUND direction (Allo -> connector). It verifies the HMAC over the canonical
 * string `${method}.${path}.${timestamp}.${rawBody}`.
 *
 * CRITICAL PATH-MATCHING DETAIL: Allo's outbound signer
 * (`BridgeService.signBridgeRequest` / `routes/bridge.proxyToConnector`) signs
 * the EXACT relative path it POSTs to — `/commands`, `/sessions/telegram/link`,
 * `/sessions/telegram/link/code`, `/sessions/telegram/link/password`,
 * `/sessions/telegram/logout`. So the connector verifies against the path IT
 * RECEIVED (`req.path`), not a stable literal — the symmetric counterpart of the
 * backend, where the CONNECTOR is the signer and Allo binds a stable literal.
 *
 * Never logs bodies, secrets, or signatures.
 */

/** Request augmented with the raw body bytes captured by `express.json({ verify })`. */
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * `express.json({ verify })` hook stashing the raw body on the request so the
 * HMAC is computed over the EXACT bytes Allo signed (a re-serialization would
 * differ in key order / whitespace). Mirrors the backend's `captureRawBody`.
 */
export function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  (req as RawBodyRequest).rawBody = buf;
}

/** Send a minimal JSON error (shape Allo's proxy tolerates: it only reads status). */
function sendError(res: Response, status: number, reason: string): void {
  res.status(status).json({ error: reason });
}

/**
 * Authenticate an inbound Allo->connector JSON request. On success calls `next()`;
 * on failure sends the appropriate status and stops. The bridge must be enabled
 * (defense in depth — routes aren't mounted when disabled either).
 */
export function verifyAlloRequest(req: Request, res: Response, next: NextFunction): void {
  if (!isBridgeEnabled()) {
    sendError(res, 404, "not_found");
    return;
  }

  const rawBody = (req as RawBodyRequest).rawBody;
  if (!rawBody) {
    logger.warn("Inbound Allo request rejected: raw body unavailable for verification");
    sendError(res, 400, "missing_body");
    return;
  }

  const result = verifyInboundJson({
    method: req.method,
    // The path Allo signed is the path the connector received, WITHOUT any query
    // string. `req.path` excludes the query; the session status route carries a
    // `?userId=` but that route is unsigned (GET), so signed routes never see a
    // query here.
    path: req.path,
    rawBody: rawBody.toString("utf8"),
    timestampHeader: req.header(BRIDGE_TIMESTAMP_HEADER),
    signatureHeader: req.header(BRIDGE_SIGNATURE_HEADER),
  });

  if (!result.ok) {
    if (result.status === 500) {
      logger.error("Inbound Allo request rejected: bridge not configured (secret missing/short)");
    } else {
      logger.warn(`Inbound Allo request rejected: ${result.reason}`);
    }
    sendError(res, result.status, result.reason);
    return;
  }

  next();
}
