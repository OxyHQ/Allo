import { Request, Response, NextFunction } from "express";
import { sendErrorResponse } from "../utils/apiHelpers";
import { logger } from "../utils/logger";
import {
  isBridgeEnabled,
  getBridgeSharedSecret,
  BRIDGE_TIMESTAMP_HEADER,
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_TIMESTAMP_TOLERANCE_MS,
  BRIDGE_EVENTS_PATH,
  BRIDGE_MEDIA_PATH,
} from "../config/bridge";
import {
  buildCanonicalString,
  buildMediaCanonicalString,
  hmacHex,
  timingSafeEqualHex,
} from "../utils/bridgeSigning";

/**
 * Request augmented with the raw request body bytes, captured by the scoped
 * `express.json({ verify })` mounted ahead of this middleware. We must HMAC over
 * the EXACT bytes the connector signed, not a re-serialization of the parsed
 * body (key ordering / whitespace would differ). Only JSON requests (`/events`)
 * have a captured body; multipart uploads (`/media`) do not — they use
 * header-only signing via `bridgeMediaAuth`.
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
 * Outcome of the common pre-signature guards (enabled? secret valid? timestamp
 * present, numeric, and in-window? signature header present?). On failure the
 * response has already been sent and `secret`/`signature` are absent.
 */
type GuardResult =
  | { ok: true; secret: string; timestampHeader: string; signatureHeader: string }
  | { ok: false };

/**
 * Run the guards shared by `bridgeAuth` and `bridgeMediaAuth`: the bridge must
 * be enabled, the secret must be present AND long enough (a too-short secret is
 * coerced to undefined upstream), a timestamp + signature header must be
 * present, and the timestamp must be numeric and inside the replay window. The
 * ONLY thing left for each caller is to build its canonical string and compare.
 * Never logs bodies, secrets, or signatures.
 */
function runCommonGuards(req: Request, res: Response): GuardResult {
  if (!isBridgeEnabled()) {
    // Defense-in-depth: the route isn't mounted when disabled either.
    sendErrorResponse(res, 404, "Not Found", "Not Found");
    return { ok: false };
  }

  const secret = getBridgeSharedSecret();
  if (!secret) {
    logger.error(
      "Bridge is enabled but BRIDGE_SHARED_SECRET is missing or too short; rejecting request"
    );
    sendErrorResponse(res, 500, "Internal Server Error", "Bridge not configured");
    return { ok: false };
  }

  const timestampHeader = req.header(BRIDGE_TIMESTAMP_HEADER);
  const signatureHeader = req.header(BRIDGE_SIGNATURE_HEADER);
  if (!timestampHeader || !signatureHeader) {
    logger.warn("Bridge request rejected: missing timestamp or signature header");
    sendErrorResponse(res, 401, "Unauthorized", "Missing authentication headers");
    return { ok: false };
  }

  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) {
    logger.warn("Bridge request rejected: non-numeric timestamp header");
    sendErrorResponse(res, 401, "Unauthorized", "Invalid timestamp");
    return { ok: false };
  }

  if (Math.abs(Date.now() - timestamp) > BRIDGE_TIMESTAMP_TOLERANCE_MS) {
    logger.warn("Bridge request rejected: timestamp outside tolerance window");
    sendErrorResponse(res, 401, "Unauthorized", "Stale or future timestamp");
    return { ok: false };
  }

  return { ok: true, secret, timestampHeader, signatureHeader };
}

/**
 * Authenticate an inbound JSON request from the connector via HMAC-SHA256 over
 * the canonical string `${method}.${path}.${timestamp}.${rawBody}` (see
 * `utils/bridgeSigning`). Binding method + path stops a captured signature from
 * being replayed against a different endpoint inside the timestamp window. The
 * `path` is the STABLE literal `BRIDGE_EVENTS_PATH` (not `req.originalUrl`) so
 * the connector signs a deterministic string. Used for `POST /events`.
 */
export function bridgeAuth(req: Request, res: Response, next: NextFunction): void {
  const guard = runCommonGuards(req, res);
  if (!guard.ok) return;

  const rawBody = (req as BridgeRequest).rawBody;
  if (!rawBody) {
    // Without the raw bytes we cannot verify the signature (e.g. the scoped
    // raw-body capture wasn't mounted ahead of us).
    logger.warn("Bridge request rejected: raw body unavailable for verification");
    sendErrorResponse(res, 400, "Bad Request", "Missing request body");
    return;
  }

  const canonical = buildCanonicalString(
    req.method,
    BRIDGE_EVENTS_PATH,
    guard.timestampHeader,
    rawBody.toString("utf8")
  );
  const expected = hmacHex(guard.secret, canonical);
  if (!timingSafeEqualHex(expected, guard.signatureHeader)) {
    logger.warn("Bridge request rejected: signature mismatch");
    sendErrorResponse(res, 401, "Unauthorized", "Invalid signature");
    return;
  }

  next();
}

/**
 * Authenticate a multipart media upload from the connector. Unlike `bridgeAuth`
 * this signs HEADERS/REQUEST METADATA ONLY — `${method}.${path}.${timestamp}` +
 * a fixed action tag — and DELIBERATELY OMITS the body.
 *
 * WHY no body signing: the multipart bytes are streamed straight into multer and
 * never buffered, so there is no stable byte sequence to HMAC. Header-only
 * signing still authenticates the caller and still gives replay protection (the
 * timestamp window) for the upload ACTION; the stored file is independently
 * validated by the route (MIME allowlist + dangerous-extension blocklist +
 * MIME-derived stored extension). The `path` is the STABLE literal
 * `BRIDGE_MEDIA_PATH`. Used for `POST /media`; runs BEFORE multer.
 */
export function bridgeMediaAuth(req: Request, res: Response, next: NextFunction): void {
  const guard = runCommonGuards(req, res);
  if (!guard.ok) return;

  const canonical = buildMediaCanonicalString(
    req.method,
    BRIDGE_MEDIA_PATH,
    guard.timestampHeader
  );
  const expected = hmacHex(guard.secret, canonical);
  if (!timingSafeEqualHex(expected, guard.signatureHeader)) {
    logger.warn("Bridge media request rejected: signature mismatch");
    sendErrorResponse(res, 401, "Unauthorized", "Invalid signature");
    return;
  }

  next();
}
