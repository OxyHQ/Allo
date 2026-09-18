/**
 * The one error a route throws to answer non-2xx on the v1 surface.
 *
 * Every non-2xx answer is `ErrorResponse` from `@allo/shared-types`:
 * `{ error: { code, message, details? } }`, with `code` one of
 * `ALLO_ERROR_CODES`. The global error handler in `app.ts` is the only thing
 * that serialises one of these; a route never writes an error body itself, so
 * there is exactly one place the shape can be wrong.
 *
 * The status is derived from the code rather than passed alongside it. A code
 * carries its status in the contract table (`docs/platform/api-v1.md`), and two
 * routes answering the same code with different statuses is what a client
 * cannot be written against.
 */

import type { AlloErrorCode } from "@allo/shared-types";

export const STATUS_BY_CODE: Readonly<Record<AlloErrorCode, number>> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  epoch_conflict: 409,
  instance_not_active: 403,
  instance_revoked: 403,
  key_packages_exhausted: 409,
  idempotency_conflict: 409,
  payload_too_large: 413,
  transfer_key_missing: 409,
  backup_not_found: 404,
  rate_limited: 429,
  unavailable: 503,
  internal: 500,
};

export class AlloHttpError extends Error {
  readonly code: AlloErrorCode;
  readonly status: number;
  readonly details: unknown;

  constructor(code: AlloErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "AlloHttpError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export function isAlloHttpError(error: unknown): error is AlloHttpError {
  return error instanceof AlloHttpError;
}

/** Shorthands for the codes routes raise most. */
export const unauthorized = (message = "Unauthorized") => new AlloHttpError("unauthorized", message);
export const forbidden = (message = "Forbidden") => new AlloHttpError("forbidden", message);
export const notFound = (message = "Not found") => new AlloHttpError("not_found", message);
export const validationFailed = (message: string, details?: unknown) =>
  new AlloHttpError("validation_failed", message, details);
