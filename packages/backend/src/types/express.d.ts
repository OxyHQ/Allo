/**
 * What this service attaches to an Express request.
 *
 * `rawBody` is captured by `express.json({ verify })` and `express.raw({ verify })`
 * in `app.ts`, because the instance signature covers the bytes that arrived.
 * `instance` is set by `requireInstance` (`middleware/instanceAuth.ts`) after
 * the signature has verified. `userId` / `user` come from `@oxy.so/core`'s own
 * `OxyAuthRequest` augmentation and are not repeated here.
 */

import type { AuthenticatedInstance } from "../middleware/instanceAuth";

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
      instance?: AuthenticatedInstance;
    }
  }
}

export {};
