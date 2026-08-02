/**
 * Error inspection helpers for `unknown` values caught in `catch` blocks.
 *
 * These avoid `any` while supporting the two error shapes the app sees:
 * - Axios-style HTTP errors with `error.response.status` / `error.response.data`
 * - Standard `Error` instances with a `message`
 */

/** Shape of an Axios-like HTTP error response (only the fields we read). */
interface HttpErrorShape {
  status?: number;
  response?: {
    status?: number;
    data?: { message?: string } | unknown;
  };
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Returns the HTTP status code from an HTTP error, or undefined.
 *
 * Two places, because the Oxy client writes two. `HttpService` sets `status` on
 * the error AND a `response` object beside it, but not every path through it
 * builds both — the XHR upload path carries only `status`. Reading `response`
 * alone therefore reports "no status" for a request that failed with a perfectly
 * ordinary 404, and a caller that treats a missing status as "not a client
 * error" then draws the opposite conclusion from the truth.
 *
 * That is not hypothetical: it opened the circuit breaker on
 * `profile/design/:id` in production, taking out an endpoint the server was
 * answering correctly. `error.status` is checked first because it is the one
 * every path sets. Homiio's `savedPropertiesApi` reads both for the same reason.
 */
export function getHttpStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  if (!record) {
    return undefined;
  }
  if (typeof record.status === 'number') {
    return record.status;
  }
  const status = asRecord(record.response)?.status;
  return typeof status === 'number' ? status : undefined;
}

/** Extracts a human-readable message from an unknown error value. */
export function getErrorMessage(error: unknown): string | undefined {
  const record = asRecord(error) as HttpErrorShape | null;
  if (!record) {
    return typeof error === 'string' ? error : undefined;
  }

  const data = asRecord(record.response?.data);
  const dataMessage = data?.message;
  if (typeof dataMessage === 'string') return dataMessage;

  if (typeof record.message === 'string') return record.message;

  return undefined;
}

/** True when the error message indicates a user-cancelled/closed auth flow. */
export function isAuthCancellation(error: unknown): boolean {
  const message = getErrorMessage(error)?.toLowerCase() ?? '';
  return message.includes('cancelled') || message.includes('closed');
}
