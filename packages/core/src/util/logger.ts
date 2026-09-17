/**
 * The SDK logs identifiers and outcomes, never message plaintext, keys or
 * tokens. Callers pass a `Logger`; the default is silent.
 */
export interface Logger {
  debug?(message: string, meta?: Record<string, unknown>): void;
  info?(message: string, meta?: Record<string, unknown>): void;
  warn?(message: string, meta?: Record<string, unknown>): void;
  error?(message: string, meta?: Record<string, unknown>): void;
}

export const silentLogger: Logger = {};

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
