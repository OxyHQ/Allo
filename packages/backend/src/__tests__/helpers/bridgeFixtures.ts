import crypto from "crypto";
import {
  BRIDGE_EVENTS_PATH,
  BRIDGE_MEDIA_PATH,
  BRIDGE_SECRET_MIN_LENGTH,
} from "../../config/bridge";
import { BRIDGE_MEDIA_ACTION_TAG } from "../../utils/bridgeSigning";

/**
 * Shared test secret for the bridge. MUST be >= BRIDGE_SECRET_MIN_LENGTH (32)
 * chars or `getBridgeSharedSecret()` coerces it to `undefined` and every signed
 * request 500s. Computed from the real minimum so it can never drift below it.
 */
export const TEST_BRIDGE_SECRET = "x".repeat(BRIDGE_SECRET_MIN_LENGTH + 8);

/** A secret that is present but BELOW the minimum length (rejected). */
export const TEST_BRIDGE_SECRET_TOO_SHORT = "x".repeat(BRIDGE_SECRET_MIN_LENGTH - 1);

/**
 * Sign a JSON `/events` request exactly as the connector must: HMAC-SHA256 over
 * `${method}.${path}.${timestamp}.${rawBody}`. `path` defaults to the stable
 * `BRIDGE_EVENTS_PATH` literal; pass a different path to prove cross-endpoint
 * replay is rejected.
 */
export function signEvents(
  timestamp: string,
  rawBody: string,
  path: string = BRIDGE_EVENTS_PATH,
  method = "POST",
  secret: string = TEST_BRIDGE_SECRET
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${method.toUpperCase()}.${path}.${timestamp}.${rawBody}`)
    .digest("hex");
}

/**
 * Sign a `/media` multipart upload exactly as the connector must: HMAC-SHA256
 * over `${method}.${path}.${timestamp}.${BRIDGE_MEDIA_ACTION_TAG}` — NO body.
 */
export function signMedia(
  timestamp: string,
  path: string = BRIDGE_MEDIA_PATH,
  method = "POST",
  secret: string = TEST_BRIDGE_SECRET
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${method.toUpperCase()}.${path}.${timestamp}.${BRIDGE_MEDIA_ACTION_TAG}`)
    .digest("hex");
}
