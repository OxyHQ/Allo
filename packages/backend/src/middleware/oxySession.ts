/**
 * `requireOxySession` — the `/v1` half of Oxy authentication.
 *
 * `createOxyAuthMiddleware` answers a missing or invalid bearer with Oxy's
 * own envelope (`{ error, message }`), which the `/api` routes have always
 * spoken and keep speaking. The `/v1` contract is `{ error: { code, message } }`
 * (`docs/platform/api-v1.md`), so `/v1` is mounted behind
 * `createOptionalOxyAuth` — which attaches the session when the bearer is good
 * and passes the request through anonymous otherwise — followed by this guard,
 * which turns "anonymous" into the contract's 401 `unauthorized` through the
 * one error handler. An expired, malformed or absent token all land here.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";
import { getOxyUserId } from "@oxy.so/core/server";
import { unauthorized } from "../utils/httpErrors";

export const requireOxySession: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
  if (getOxyUserId(req) === null) {
    next(unauthorized("An Oxy session is required"));
    return;
  }
  next();
};
