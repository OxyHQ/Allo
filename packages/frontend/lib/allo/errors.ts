import { TransportError } from '@allo/core';
/** Preserve SDK error identity at the client seam; consumers do not construct SDK values. */
export function isAlloNotFound(error: unknown): boolean {
  return error instanceof TransportError && error.status === 404;
}
