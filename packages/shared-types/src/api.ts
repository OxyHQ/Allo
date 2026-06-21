/**
 * Shared API transport contract for Allo.
 *
 * These types model the HTTP response envelope the backend serializes
 * (see `packages/backend/src/utils/apiHelpers.ts`) and the frontend
 * receives over the wire (`packages/frontend/utils/api.ts`).
 */

/**
 * Standard API error response format.
 * Emitted by `sendErrorResponse`.
 */
export interface ApiErrorResponse {
  error: string;
  message: string;
}

/**
 * Standard API success response envelope.
 * Emitted by `sendSuccessResponse` — the payload lives under `data`.
 */
export interface ApiSuccessResponse<T = unknown> {
  success?: boolean;
  message?: string;
  data?: T;
}

/**
 * Offset-based pagination options accepted by list endpoints
 * (e.g. `GET /api/conversations`, `GET /api/messages`).
 */
export interface PaginationOptions {
  limit?: number;
  offset?: number;
}
