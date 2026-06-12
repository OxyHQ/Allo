/**
 * FLOOD_WAIT detection for gramjs.
 *
 * gramjs throws `FloodWaitError` (and the related `SlowModeWaitError` /
 * `FloodTestPhoneWaitError`, all extending `FloodError`) when an account acts too
 * fast; each carries a `seconds` hint for how long to wait. We detect these
 * STRUCTURALLY rather than via `instanceof FloodWaitError` so the check is robust
 * across module/realm boundaries and trivially mockable in tests (a plain object
 * with the right `errorMessage`/`seconds` is recognised). A real gramjs error
 * exposes `errorMessage` like `"FLOOD_WAIT_42"` and a numeric `seconds`.
 */

/** A detected flood wait: the network is asking us to wait `seconds`. */
export interface FloodWait {
  seconds: number;
}

/** The error-message prefixes gramjs uses for flood-style waits. */
const FLOOD_MESSAGE_PREFIXES = ["FLOOD_WAIT", "FLOOD_PREMIUM_WAIT", "SLOWMODE_WAIT"];

/** Read a finite non-negative number from an unknown field, or undefined. */
function readSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return undefined;
}

/**
 * If `error` is a Telegram flood-wait, return `{ seconds }`; otherwise null.
 *
 * Recognises either:
 *  - a real gramjs flood error (constructor name endsWith "FloodWaitError" /
 *    "FloodError", or `errorMessage` starting with a known FLOOD prefix), OR
 *  - any error carrying a numeric `seconds` plus a flood-ish message,
 * and extracts the `seconds` hint (falling back to parsing it out of the message
 * when the field is absent, then 0 if truly unknown).
 */
export function detectFloodWait(error: unknown): FloodWait | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { errorMessage?: unknown; message?: unknown; seconds?: unknown; name?: unknown };

  const message =
    (typeof e.errorMessage === "string" && e.errorMessage) ||
    (typeof e.message === "string" && e.message) ||
    "";
  const name = typeof e.name === "string" ? e.name : "";

  const looksLikeFlood =
    FLOOD_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix)) ||
    name.endsWith("FloodWaitError") ||
    name.endsWith("FloodError") ||
    name.endsWith("SlowModeWaitError");
  if (!looksLikeFlood) return null;

  const fromField = readSeconds(e.seconds);
  if (fromField !== undefined) return { seconds: fromField };

  // Fall back to the trailing number in messages like "FLOOD_WAIT_42".
  const match = message.match(/(\d+)\s*$/);
  const parsed = match ? Number(match[1]) : Number.NaN;
  return { seconds: Number.isFinite(parsed) ? parsed : 0 };
}
