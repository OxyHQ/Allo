/**
 * Error inspection helpers for `unknown` values caught in `catch` blocks.
 *
 * These avoid `any` while supporting the two error shapes the app sees:
 * - Axios-style HTTP errors with `error.response.status` / `error.response.data`
 * - Standard `Error` instances with a `message`
 */

/** Shape of an Axios-like HTTP error response (only the fields we read). */
interface HttpErrorShape {
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

/** Returns the HTTP status code from an Axios-like error, or undefined. */
export function getHttpStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  const response = record ? asRecord(record.response) : null;
  const status = response?.status;
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
