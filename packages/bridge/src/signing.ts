import crypto from "crypto";
import {
  BRIDGE_MEDIA_ACTION_TAG,
  BRIDGE_TIMESTAMP_TOLERANCE_MS,
  getBridgeSharedSecret,
} from "./config";

/**
 * Canonical HMAC signing for the interop bridge — the connector's MIRROR of the
 * Allo backend's `utils/bridgeSigning.ts`.
 *
 * DELIBERATE DUPLICATION: `@allo/shared-types` is a types-only package (no
 * runtime emit consumed at runtime by these services), so it cannot host this
 * ~30-line crypto glue. Standing up a brand-new shared RUNTIME package purely to
 * dedupe four tiny pure functions would add a build/publish edge for negligible
 * benefit. We instead copy the exact builders here and pin their correctness with
 * a test that asserts byte-identical canonical strings against the backend's
 * vectors (`signing.test.ts`). If the backend's canonical form ever changes, that
 * test fails loudly and forces this file to be updated in lockstep.
 *
 * Two canonical forms, IDENTICAL to the backend:
 *
 *  1. JSON requests bind METHOD + PATH + timestamp + the EXACT request body bytes:
 *         HMAC-SHA256( secret, `${method}.${path}.${timestamp}.${rawBody}` )
 *  2. Multipart media uploads bind METHOD + PATH + timestamp + a fixed action tag
 *     and OMIT the body (the multipart bytes are streamed, never buffered):
 *         HMAC-SHA256( secret, `${method}.${path}.${timestamp}.${ACTION_TAG}` )
 *
 * `method` is upper-cased so casing differences between sides are irrelevant.
 */

/** Build the canonical string for a JSON (body-bearing) bridge request. */
export function buildCanonicalString(
  method: string,
  path: string,
  timestamp: string,
  rawBody: string
): string {
  return `${method.toUpperCase()}.${path}.${timestamp}.${rawBody}`;
}

/** Build the canonical string for a multipart media upload (no body signed). */
export function buildMediaCanonicalString(
  method: string,
  path: string,
  timestamp: string
): string {
  return `${method.toUpperCase()}.${path}.${timestamp}.${BRIDGE_MEDIA_ACTION_TAG}`;
}

/** Compute the hex HMAC-SHA256 of `canonical` under `secret`. */
export function hmacHex(secret: string, canonical: string): string {
  return crypto.createHmac("sha256", secret).update(canonical).digest("hex");
}

/**
 * Constant-time hex-string compare, guarding length equality first.
 * `crypto.timingSafeEqual` throws on unequal lengths, so a length mismatch is
 * turned into a clean `false` rather than a throw (and never leaks via the
 * exception path). Mirrors the backend's `timingSafeEqualHex`.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Whether a numeric ms timestamp is inside the ±tolerance replay window. */
export function isTimestampFresh(timestampMs: number, nowMs: number = Date.now()): boolean {
  return Math.abs(nowMs - timestampMs) <= BRIDGE_TIMESTAMP_TOLERANCE_MS;
}

/** Outcome of verifying an inbound JSON request from Allo. */
export type VerifyResult =
  | { ok: true }
  | { ok: false; status: 401 | 500; reason: string };

/**
 * Verify an inbound Allo->connector JSON request. The caller passes the exact
 * raw body bytes Allo signed, the timestamp/signature headers, and the canonical
 * PATH the SIGNER used (for `/commands` that is `/commands`; for sessions it is
 * the session sub-path). Returns a structured result; NEVER logs the body,
 * secret, or signature. Pure aside from `getBridgeSharedSecret()`/`Date.now()`.
 */
export function verifyInboundJson(params: {
  method: string;
  path: string;
  rawBody: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
}): VerifyResult {
  const secret = getBridgeSharedSecret();
  if (!secret) {
    return { ok: false, status: 500, reason: "bridge_not_configured" };
  }
  const { timestampHeader, signatureHeader } = params;
  if (!timestampHeader || !signatureHeader) {
    return { ok: false, status: 401, reason: "missing_auth_headers" };
  }
  const timestamp = Number(timestampHeader);
  if (!Number.isInteger(timestamp)) {
    return { ok: false, status: 401, reason: "invalid_timestamp" };
  }
  if (!isTimestampFresh(timestamp)) {
    return { ok: false, status: 401, reason: "stale_or_future_timestamp" };
  }
  const canonical = buildCanonicalString(
    params.method,
    params.path,
    timestampHeader,
    params.rawBody
  );
  const expected = hmacHex(secret, canonical);
  if (!timingSafeEqualHex(expected, signatureHeader)) {
    return { ok: false, status: 401, reason: "invalid_signature" };
  }
  return { ok: true };
}

/**
 * Sign a connector->Allo JSON request. Produces the timestamp + hex signature
 * Allo's `bridgeAuth` will reconstruct and verify (same `buildCanonicalString`).
 * @throws if the shared secret is unset/too short (callers wrap in try/catch).
 */
export function signOutboundJson(
  method: string,
  path: string,
  rawBody: string
): { timestamp: string; signature: string } {
  const secret = getBridgeSharedSecret();
  if (!secret) {
    throw new Error("BRIDGE_SHARED_SECRET is not configured");
  }
  const timestamp = String(Date.now());
  const signature = hmacHex(secret, buildCanonicalString(method, path, timestamp, rawBody));
  return { timestamp, signature };
}

/**
 * Sign a connector->Allo multipart media upload (header-only, body omitted).
 * Produces the timestamp + signature Allo's `bridgeMediaAuth` verifies.
 * @throws if the shared secret is unset/too short.
 */
export function signOutboundMedia(
  method: string,
  path: string
): { timestamp: string; signature: string } {
  const secret = getBridgeSharedSecret();
  if (!secret) {
    throw new Error("BRIDGE_SHARED_SECRET is not configured");
  }
  const timestamp = String(Date.now());
  const signature = hmacHex(secret, buildMediaCanonicalString(method, path, timestamp));
  return { timestamp, signature };
}
