import crypto from "crypto";
import { BRIDGE_MEDIA_ACTION_TAG, BRIDGE_SECRET_MIN_LENGTH } from "../../config";

/**
 * Test signing helpers that REPRODUCE the Allo backend's
 * `__tests__/helpers/bridgeFixtures.ts` byte-for-byte. They independently compute
 * the HMAC the way the BACKEND does, so a test that signs with these and verifies
 * with the connector's `signing.ts` proves the two implementations agree on the
 * canonical string — the whole point of the duplicated crypto glue.
 */

/** Same construction as the backend's `TEST_BRIDGE_SECRET` (>= 32 chars). */
export const TEST_BRIDGE_SECRET = "x".repeat(BRIDGE_SECRET_MIN_LENGTH + 8);

/** A present-but-too-short secret (rejected by `getBridgeSharedSecret`). */
export const TEST_BRIDGE_SECRET_TOO_SHORT = "x".repeat(BRIDGE_SECRET_MIN_LENGTH - 1);

/** A valid >= 32-char session-encryption key for crypto tests. */
export const TEST_SESSION_KEY = "k".repeat(BRIDGE_SECRET_MIN_LENGTH + 4);

/**
 * Sign a JSON request EXACTLY as Allo's backend does (the connector is the
 * receiver): HMAC-SHA256 over `${method}.${path}.${timestamp}.${rawBody}`.
 */
export function signJson(
  timestamp: string,
  path: string,
  rawBody: string,
  method = "POST",
  secret: string = TEST_BRIDGE_SECRET
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${method.toUpperCase()}.${path}.${timestamp}.${rawBody}`)
    .digest("hex");
}

/** Sign a media (header-only) request as the backend does — used for parity tests. */
export function signMedia(
  timestamp: string,
  path: string,
  method = "POST",
  secret: string = TEST_BRIDGE_SECRET
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${method.toUpperCase()}.${path}.${timestamp}.${BRIDGE_MEDIA_ACTION_TAG}`)
    .digest("hex");
}
