/**
 * Minimal structured logger, mirroring the Allo backend's `utils/logger.ts`.
 *
 * HARD RULE for this service: NEVER pass message bodies, Telegram session
 * strings, login codes, 2FA passwords, or the shared secret to any logger call.
 * Log identifiers (userId, network, chat/message ids) and outcomes only. This is
 * enforced by convention and reviewed in tests/hygiene — the logger itself does
 * not redact, so callers must not hand it secret material.
 */

/**
 * Loggable value. `unknown` is intentionally accepted for the error position so a
 * `catch (error: unknown)` value can be passed straight through without an unsafe
 * cast — the logger only ever stringifies it for output, never inspects it.
 */
type LogArg = unknown;

export const logger = {
  info: (message: string, ...args: LogArg[]): void => {
    // eslint-disable-next-line no-console
    console.log(`[INFO] ${message}`, ...args);
  },
  error: (message: string, error?: LogArg): void => {
    // eslint-disable-next-line no-console
    console.error(`[ERROR] ${message}`, error ?? "");
  },
  warn: (message: string, ...args: LogArg[]): void => {
    // eslint-disable-next-line no-console
    console.warn(`[WARN] ${message}`, ...args);
  },
  debug: (message: string, ...args: LogArg[]): void => {
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  },
};
