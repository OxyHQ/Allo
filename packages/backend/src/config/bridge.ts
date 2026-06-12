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

import { logger } from "../utils/logger";

const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;

/** Guard so the "secret too short" warning is emitted at most once per process. */
let warnedSecretTooShort = false;

/** Log (once) that the configured secret is too short — never logs the value. */
function warnSecretTooShortOnce(): void {
  if (warnedSecretTooShort) return;
  warnedSecretTooShort = true;
  logger.error(
    `BRIDGE_SHARED_SECRET is set but shorter than the required ${BRIDGE_SECRET_MIN_LENGTH} characters; treating the bridge as not configured`
  );
}

/** True only when `BRIDGE_ENABLED` is exactly the string "true". */
export function isBridgeEnabled(): boolean {
  return process.env.BRIDGE_ENABLED === "true";
}

/**
 * Minimum accepted length for `BRIDGE_SHARED_SECRET`. A short secret is
 * brute-forceable, so anything below this is treated as if the secret were
 * unset (callers reject the request as "Bridge not configured"). 32 chars of
 * high-entropy material (e.g. `openssl rand -hex 32` = 64 hex chars) is the
 * intended floor.
 */
export const BRIDGE_SECRET_MIN_LENGTH = 32;

/**
 * The configured shared secret, but ONLY if it is present AND at least
 * `BRIDGE_SECRET_MIN_LENGTH` chars. Otherwise `undefined`, so the existing
 * `if (!secret)` guards in `bridgeAuth`/`signBridgeRequest` reject the request.
 * A too-short secret is logged ONCE per process (the value is never logged).
 */
export function getBridgeSharedSecret(): string | undefined {
  const secret = process.env.BRIDGE_SHARED_SECRET;
  if (!secret) return undefined;
  if (secret.length < BRIDGE_SECRET_MIN_LENGTH) {
    warnSecretTooShortOnce();
    return undefined;
  }
  return secret;
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
 * Canonical request PATHS that BOTH sides sign for the connector -> Allo
 * direction. These are STABLE literals (not derived from `req.originalUrl`) so
 * the signature is deterministic regardless of query strings, trailing slashes,
 * or how the route happens to be mounted. The connector MUST sign these exact
 * strings.
 */
export const BRIDGE_EVENTS_PATH = "/internal/bridge/events";
export const BRIDGE_MEDIA_PATH = "/internal/bridge/media";

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

/**
 * Max rows a single sweep pass loads/processes. Bounds memory and per-tick work
 * so a large backlog can't load the entire pending set at once; the remainder is
 * picked up by the next tick.
 */
export const BRIDGE_OUTBOX_SWEEP_LIMIT = 100;

/**
 * Hard timeout for a single connector HTTP request. A connector that accepts the
 * connection but never responds would otherwise hang the request handler / the
 * sweeper indefinitely. On timeout the request is aborted and surfaces as a
 * thrown error (recorded as `lastError`, the row stays pending and backs off).
 */
export const BRIDGE_REQUEST_TIMEOUT_MS = 10 * SECOND_MS;

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
