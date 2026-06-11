import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { sendErrorResponse } from "../utils/apiHelpers";
import { logger } from "../utils/logger";
import {
  isBridgeEnabled,
  getBridgeSharedSecret,
  BRIDGE_TIMESTAMP_HEADER,
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_TIMESTAMP_TOLERANCE_MS,
} from "../config/bridge";

/**
 * Request augmented with the raw request body bytes, captured by the scoped
 * `express.json({ verify })` mounted ahead of this middleware. We must HMAC over
 * the EXACT bytes the connector signed, not a re-serialization of the parsed
 * body (key ordering / whitespace would differ).
 */
export interface BridgeRequest extends Request {
  rawBody?: Buffer;
}

/**
 * `express.json({ verify })` hook that stashes the raw body on the request.
 * Exported so server.ts and tests wire up the SAME capture.
 */
export function captureRawBody(req: Request, _res: Response, buf: Buffer): void {
  (req as BridgeRequest).rawBody = buf;
}

/**
 * Canonical signing form, shared with the bridge connector:
 *
 *     HMAC-SHA256( secret, `${timestamp}.${rawBody}` )  ->  hex
 *
 * where `timestamp` is the value of the `x-bridge-timestamp` header (ms since
 * epoch) and `rawBody` is the exact UTF-8 request body. The connector computes
 * the same and sends it in `x-bridge-signature`.
 */
function expectedSignature(secret: string, timestamp: string, rawBody: Buffer): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody.toString("utf8")}`)
    .digest("hex");
}

/** Constant-time hex-string compare, guarding length equality first. */
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  // timingSafeEqual throws on unequal lengths — guard so a length mismatch is a
  // clean rejection rather than a crash (and so we never leak via the throw).
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Authenticates an inbound request from the bridge connector via HMAC-SHA256
 * over `${timestamp}.${rawBody}`. Defense-in-depth: returns 404 when the bridge
 * is disabled (the route isn't mounted in that case either). Never logs bodies,
 * secrets, or signatures.
 */
export function bridgeAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isBridgeEnabled()) {
    sendErrorResponse(res, 404, "Not Found", "Not Found");
    return;
  }

  const secret = getBridgeSharedSecret();
  if (!secret) {
    logger.error("Bridge is enabled but BRIDGE_SHARED_SECRET is not set; rejecting request");
    sendErrorResponse(res, 500, "Internal Server Error", "Bridge not configured");
    return;
  }

  const timestampHeader = req.header(BRIDGE_TIMESTAMP_HEADER);
  const signatureHeader = req.header(BRIDGE_SIGNATURE_HEADER);
  if (!timestampHeader || !signatureHeader) {
    logger.warn("Bridge request rejected: missing timestamp or signature header");
    sendErrorResponse(res, 401, "Unauthorized", "Missing authentication headers");
    return;
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) {
    logger.warn("Bridge request rejected: non-numeric timestamp header");
    sendErrorResponse(res, 401, "Unauthorized", "Invalid timestamp");
    return;
  }

  if (Math.abs(Date.now() - timestamp) > BRIDGE_TIMESTAMP_TOLERANCE_MS) {
    logger.warn("Bridge request rejected: timestamp outside tolerance window");
    sendErrorResponse(res, 401, "Unauthorized", "Stale or future timestamp");
    return;
  }

  const rawBody = (req as BridgeRequest).rawBody;
  if (!rawBody) {
    // Without the raw bytes we cannot verify the signature (e.g. the scoped
    // raw-body capture wasn't mounted ahead of us).
    logger.warn("Bridge request rejected: raw body unavailable for verification");
    sendErrorResponse(res, 400, "Bad Request", "Missing request body");
    return;
  }

  const expected = expectedSignature(secret, timestampHeader, rawBody);
  if (!timingSafeEqualHex(expected, signatureHeader)) {
    logger.warn("Bridge request rejected: signature mismatch");
    sendErrorResponse(res, 401, "Unauthorized", "Invalid signature");
    return;
  }

  next();
}
