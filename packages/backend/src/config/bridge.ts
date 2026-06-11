/**
 * Single source of truth for the interop bridge (F3.0 SEAM) — flags, headers,
 * timing, and the retry/backoff policy for the outbound outbox.
 *
 * Environment variables read by the seam (ALL optional; bridge is OFF unless
 * `BRIDGE_ENABLED` is exactly "true"):
 *
 *   BRIDGE_ENABLED        "true" enables the bridge. ANY other value (including
 *                         unset) keeps the app behaving byte-for-byte as before:
 *                         no bridge routes are mounted, no sweeper runs.
 *   BRIDGE_SHARED_SECRET  HMAC-SHA256 secret shared with the bridge connector.
 *                         Required when the bridge is enabled — used to sign
 *                         outbound commands and verify inbound events.
 *   BRIDGE_SERVICE_URL    Base URL of the bridge connector service (e.g.
 *                         http://bridge:9000). Commands are POSTed to
 *                         `${BRIDGE_SERVICE_URL}/commands` and session ops to
 *                         `${BRIDGE_SERVICE_URL}/sessions/...`.
 *
 * Env is read via getter FUNCTIONS (not module-load consts) so tests can set
 * `process.env.*` per-test and have it take effect immediately.
 */

const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;

/** True only when `BRIDGE_ENABLED` is exactly the string "true". */
export function isBridgeEnabled(): boolean {
  return process.env.BRIDGE_ENABLED === "true";
}

/** HMAC secret shared with the bridge connector (undefined when unset). */
export function getBridgeSharedSecret(): string | undefined {
  return process.env.BRIDGE_SHARED_SECRET;
}

/** Base URL of the bridge connector service (undefined when unset). */
export function getBridgeServiceUrl(): string | undefined {
  return process.env.BRIDGE_SERVICE_URL;
}

/** Request header carrying the signing timestamp (ms since epoch, as a string). */
export const BRIDGE_TIMESTAMP_HEADER = "x-bridge-timestamp";

/** Request header carrying the hex HMAC-SHA256 signature. */
export const BRIDGE_SIGNATURE_HEADER = "x-bridge-signature";

/**
 * Max clock skew tolerated between the signer's timestamp and now. A request
 * whose timestamp is more than this far in the past OR future is rejected
 * (replay / stale-request protection). 5 minutes.
 */
export const BRIDGE_TIMESTAMP_TOLERANCE_MS = 5 * MINUTE_MS;

/** Give up on an outbox row after this many failed delivery attempts. */
export const BRIDGE_OUTBOX_MAX_ATTEMPTS = 6;

/** How often the background sweeper scans for due outbox rows. */
export const BRIDGE_OUTBOX_SWEEP_INTERVAL_MS = 15 * SECOND_MS;

/** Base delay for the exponential backoff (delay after the 1st failure). */
export const BRIDGE_BACKOFF_BASE_MS = 1 * SECOND_MS;

/** Upper bound for the exponential backoff delay (5 minutes). */
export const BRIDGE_BACKOFF_CAP_MS = 5 * MINUTE_MS;

/**
 * Exponential backoff delay (ms) before the next attempt, given the number of
 * attempts MADE so far. Pure and deterministic so it can be unit-tested:
 *
 *   attempts <= 0 -> BASE
 *   attempts  = 1 -> BASE * 2^0 = BASE
 *   attempts  = 2 -> BASE * 2^1
 *   ...capped at CAP.
 */
export function computeBackoffMs(attempts: number): number {
  if (attempts <= 0) return BRIDGE_BACKOFF_BASE_MS;
  const delay = BRIDGE_BACKOFF_BASE_MS * 2 ** (attempts - 1);
  return Math.min(BRIDGE_BACKOFF_CAP_MS, delay);
}
