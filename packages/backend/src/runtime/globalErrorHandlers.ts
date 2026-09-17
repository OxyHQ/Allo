/**
 * The process-level last resort. Installed before bootstrap starts any
 * asynchronous work. Both write through the log sanitiser and neither trusts
 * the process afterwards: an uncaught exception always exits, an unhandled
 * rejection exits in production and is logged elsewhere.
 */

import { sanitizeLogValue } from "../utils/logger";

export function registerGlobalErrorHandlers(env: NodeJS.ProcessEnv = process.env): void {
  process.on("unhandledRejection", (reason: unknown) => {
    console.error("Unhandled promise rejection", sanitizeLogValue(reason));
    if (env.NODE_ENV === "production") process.exit(1);
  });
  process.on("uncaughtException", (error: Error) => {
    console.error("Uncaught exception", sanitizeLogValue(error));
    process.exit(1);
  });
}
