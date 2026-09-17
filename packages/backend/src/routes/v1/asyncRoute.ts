/**
 * Express 4 does not forward a rejected handler promise to `next`; this does,
 * so every thrown `AlloHttpError` (and every bug) reaches the one error
 * handler in `app.ts` instead of hanging the request.
 */

import type { NextFunction, Request, RequestHandler, Response } from "express";

export function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}
