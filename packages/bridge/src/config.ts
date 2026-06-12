/**
 * Single source of truth for the bridge connector's configuration — env access,
 * signing headers/timing (mirrored from the Allo backend's `config/bridge.ts`),
 * and operational constants.
 *
 * The connector is the COUNTERPARTY to the Allo backend's F3.0 seam:
 *  - it VERIFIES inbound Allo->connector requests (`/commands`, `/sessions/...`),
 *  - it SIGNS outbound connector->Allo requests (`/internal/bridge/events`,
 *    `/internal/bridge/media`).
 *
 * Both directions use hex HMAC-SHA256 over a canonical string, with the same
 * headers and the same ±5 min replay window as the backend. The canonical
 * builders live in `signing.ts`; the literal header names / window MUST match the
 * backend byte-for-byte or every request fails.
 *
 * Env is read via getter FUNCTIONS (not module-load consts) so tests can set
 * `process.env.*` per-test and have it take effect immediately — identical to the
 * backend's approach.
 */

const MINUTE_MS = 60 * 1000;
const SECOND_MS = 1000;

/** Default port the connector listens on when `BRIDGE_PORT` is unset. */
export const DEFAULT_BRIDGE_PORT = 8090;

/** Default Mongo database name for the connector's own session store. */
export const DEFAULT_BRIDGE_DB_NAME = "allo-bridge";

/**
 * Request header carrying the signing timestamp (ms since epoch, as a string).
 * MUST match the backend's `BRIDGE_TIMESTAMP_HEADER`.
 */
export const BRIDGE_TIMESTAMP_HEADER = "x-bridge-timestamp";

/**
 * Request header carrying the hex HMAC-SHA256 signature.
 * MUST match the backend's `BRIDGE_SIGNATURE_HEADER`.
 */
export const BRIDGE_SIGNATURE_HEADER = "x-bridge-signature";

/**
 * Max clock skew tolerated between a signer's timestamp and now (±5 min). MUST
 * match the backend's `BRIDGE_TIMESTAMP_TOLERANCE_MS` or legitimately-signed
 * requests would be rejected by one side and accepted by the other.
 */
export const BRIDGE_TIMESTAMP_TOLERANCE_MS = 5 * MINUTE_MS;

/**
 * Minimum accepted length for the shared HMAC secret. A short secret is
 * brute-forceable; anything below this is treated as if unset. MUST match the
 * backend's `BRIDGE_SECRET_MIN_LENGTH` (32).
 */
export const BRIDGE_SECRET_MIN_LENGTH = 32;

/**
 * Minimum accepted length for `BRIDGE_SESSION_KEY` (the AES-256-GCM key material
 * used to encrypt stored Telegram sessions at rest). 32 chars of high-entropy
 * material; a shorter key is rejected at boot.
 */
export const BRIDGE_SESSION_KEY_MIN_LENGTH = 32;

/** Canonical PATH the backend's `internalBridge` route signs for events. */
export const ALLO_EVENTS_PATH = "/internal/bridge/events";

/** Canonical PATH the backend's `internalBridge` route signs for media uploads. */
export const ALLO_MEDIA_PATH = "/internal/bridge/media";

/**
 * Action tag baked into the media-upload canonical string (no body is signed).
 * MUST match the backend's `BRIDGE_MEDIA_ACTION_TAG`.
 */
export const BRIDGE_MEDIA_ACTION_TAG = "media-upload";

/** HTTP method used for every connector->Allo request. */
export const ALLO_REQUEST_METHOD = "POST";

/** Hard timeout for a single HTTP request to the Allo backend. */
export const ALLO_REQUEST_TIMEOUT_MS = 10 * SECOND_MS;

/**
 * Per-account outbound send cap. Telegram aggressively rate-limits / bans
 * accounts that send faster than a human would; capping outbound sends per
 * account is the connector's first line of anti-ban defense. When the cap is
 * exceeded the connector returns 429 to Allo, whose durable outbox retries with
 * backoff — so no message is lost, it is merely paced.
 */
export const OUTBOUND_SENDS_PER_WINDOW = 20;

/** Sliding window for the outbound send cap. */
export const OUTBOUND_SEND_WINDOW_MS = 1 * MINUTE_MS;

/** Reconnect backoff base (delay after the 1st failed (re)connect). */
export const RECONNECT_BACKOFF_BASE_MS = 1 * SECOND_MS;

/** Reconnect backoff cap. */
export const RECONNECT_BACKOFF_CAP_MS = 5 * MINUTE_MS;

/**
 * Max Telegram FLOOD_WAIT (in seconds) the connector will treat as RETRYABLE.
 *
 * Telegram throws `FloodWaitError` (with a `seconds` hint) when an account sends
 * too fast. A short wait is normal pacing — we surface it as a retryable failure
 * so Allo's durable outbox backs off and resends after the hint. A very LONG wait
 * (account flagged) is not worth holding an outbox row open for; once the hint
 * exceeds this cap we fire a terminal `send_result: failed` so the user sees it
 * failed rather than silently hanging for tens of minutes. 5 minutes.
 */
export const FLOOD_WAIT_RETRYABLE_CAP_SECONDS = 5 * 60;

/**
 * Scheduled-retry delay applied when a client's inbound event or (re)connect loop
 * hits a FLOOD_WAIT. Bounds how long we wait before retrying so a flood can't
 * wedge a client loop indefinitely; the real per-send pacing is Allo's outbox.
 */
export const FLOOD_WAIT_LOOP_RETRY_CAP_MS = 5 * MINUTE_MS;

/**
 * How long a `send` command's `messageId` is remembered for in-process
 * deduplication.
 *
 * WHY: `/commands` now AWAITS the Telegram send (so a FLOOD_WAIT can map to the
 * right HTTP status). But the backend aborts that request after its own ~10s
 * timeout, and its durable outbox then RETRIES the same command — while the
 * connector may still be mid-send (e.g. a large media upload). Without a guard the
 * retry would send the SAME message to Telegram twice. We remember each
 * `messageId` from the moment the send STARTS until this TTL elapses; a duplicate
 * arriving in that window is acknowledged WITHOUT re-sending (the original
 * `send_result` will arrive / has arrived). The window must comfortably exceed the
 * backend's request timeout (≥ 2× + margin) so a timed-out-then-retried command is
 * still recognised as a duplicate. 60s.
 */
export const SEND_DEDUP_TTL_MS = 60 * SECOND_MS;

/**
 * Hard upper bound on the number of remembered `messageId`s. A defensive cap so a
 * flood of distinct messages (or a bug) can't grow the dedup map without limit;
 * once reached, the oldest entries are evicted (they are well past being useful
 * retries anyway). Sized generously relative to realistic in-flight + recently
 * completed sends.
 */
export const SEND_DEDUP_MAX_ENTRIES = 10000;

/**
 * How long a pending QR / phone login attempt is held before it is abandoned.
 * Telegram QR tokens expire on their own; this bounds the connector's memory for
 * abandoned logins.
 */
export const LOGIN_ATTEMPT_TTL_MS = 5 * MINUTE_MS;

/** True only when `BRIDGE_ENABLED` is exactly the string "true". */
export function isBridgeEnabled(): boolean {
  return process.env.BRIDGE_ENABLED === "true";
}

/** Port the connector listens on (`BRIDGE_PORT`, default 8090). */
export function getBridgePort(): number {
  const raw = process.env.BRIDGE_PORT;
  if (!raw) return DEFAULT_BRIDGE_PORT;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_BRIDGE_PORT;
}

/**
 * The shared HMAC secret, but ONLY if present AND at least
 * `BRIDGE_SECRET_MIN_LENGTH` chars; otherwise `undefined` so callers reject the
 * request. The value is NEVER logged.
 */
export function getBridgeSharedSecret(): string | undefined {
  const secret = process.env.BRIDGE_SHARED_SECRET;
  if (!secret) return undefined;
  if (secret.length < BRIDGE_SECRET_MIN_LENGTH) return undefined;
  return secret;
}

/**
 * The session-encryption key, but ONLY if present AND long enough; otherwise
 * `undefined`. Stored sessions cannot be written/read without it. NEVER logged.
 */
export function getBridgeSessionKey(): string | undefined {
  const key = process.env.BRIDGE_SESSION_KEY;
  if (!key) return undefined;
  if (key.length < BRIDGE_SESSION_KEY_MIN_LENGTH) return undefined;
  return key;
}

/**
 * Base URL of the Allo backend's internal API (e.g. http://allo-backend:8080).
 * Events/media are POSTed to `${ALLO_INTERNAL_URL}/internal/bridge/...`.
 */
export function getAlloInternalUrl(): string | undefined {
  return process.env.ALLO_INTERNAL_URL;
}

/** Mongo connection string for the connector's session store. */
export function getBridgeMongoUri(): string | undefined {
  return process.env.BRIDGE_MONGODB_URI ?? process.env.MONGODB_URI;
}

/** Mongo database name for the connector's session store. */
export function getBridgeDbName(): string {
  return process.env.BRIDGE_DB_NAME ?? DEFAULT_BRIDGE_DB_NAME;
}

/**
 * Telegram API credentials (created by the operator at https://my.telegram.org).
 * Returns null when EITHER is unset — without both, no Telegram login can begin,
 * and session ops return 503 `telegram_not_configured`. The connector still
 * BOOTS fine without them (health check stays green; only Telegram ops fail).
 */
export function getTelegramApiCredentials(): { apiId: number; apiHash: string } | null {
  const apiIdRaw = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiIdRaw || !apiHash) return null;
  const apiId = Number(apiIdRaw);
  if (!Number.isInteger(apiId) || apiId <= 0) return null;
  return { apiId, apiHash };
}

/**
 * Exponential backoff delay (ms) before the next reconnect attempt, given the
 * number of attempts MADE so far. Pure/deterministic so it can be unit-tested.
 */
export function computeReconnectBackoffMs(attempts: number): number {
  if (attempts <= 0) return RECONNECT_BACKOFF_BASE_MS;
  const delay = RECONNECT_BACKOFF_BASE_MS * 2 ** (attempts - 1);
  return Math.min(RECONNECT_BACKOFF_CAP_MS, delay);
}
