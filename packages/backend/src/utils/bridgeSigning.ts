import crypto from "crypto";

/**
 * Canonical HMAC signing for the interop bridge (F3.0 SEAM).
 *
 * The signer (Allo -> connector via `BridgeService`/`routes/bridge`) and the
 * verifier (connector -> Allo via `middleware/bridgeAuth`) MUST build the exact
 * same canonical string for the same request, or every request would fail.
 * Keeping the builders here — used by BOTH sides — guarantees they can never
 * drift.
 *
 * There are two canonical forms:
 *
 *  1. JSON requests (the common case: `/events`, `/commands`, `/sessions/...`)
 *     bind the HTTP METHOD + request PATH + timestamp + the EXACT request body
 *     bytes. Binding method+path stops a captured signature from being replayed
 *     against a DIFFERENT endpoint inside the timestamp window. Binding the raw
 *     body (not a re-serialization) means key-ordering/whitespace differences
 *     can't invalidate a legitimate request.
 *
 *         HMAC-SHA256( secret, `${method}.${path}.${timestamp}.${rawBody}` )
 *
 *  2. Multipart media uploads (`/media`) bind METHOD + PATH + timestamp + a
 *     fixed action tag and DELIBERATELY OMIT the body. The multipart bytes are
 *     streamed straight into multer and never buffered for HMAC, so there is no
 *     stable body to sign. Header-only signing still authenticates the caller
 *     and still gives replay protection (timestamp window) for the upload
 *     ACTION; the stored file is independently validated (MIME allowlist +
 *     dangerous-extension blocklist + MIME-derived extension) by the route.
 *
 *         HMAC-SHA256( secret, `${method}.${path}.${timestamp}.${MEDIA_ACTION_TAG}` )
 *
 * `method` is upper-cased so casing differences between sides are irrelevant.
 */

/** Action tag baked into the media-upload canonical string (no body is signed). */
export const BRIDGE_MEDIA_ACTION_TAG = "media-upload";

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
 * exception path).
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Options accepted by `fetchWithTimeout` (a typed subset of `RequestInit`). */
export interface FetchWithTimeoutInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

/**
 * `fetch` with a hard timeout via `AbortController`. A connector that accepts
 * the TCP connection but never responds would otherwise hang the request (and
 * the outbox sweeper) indefinitely. On timeout the abort surfaces as a thrown
 * error so callers' existing try/catch records it and retries/backs off.
 */
export async function fetchWithTimeout(
  url: string,
  init: FetchWithTimeoutInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
