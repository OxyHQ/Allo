/**
 * One log line per request: request id, method, ROUTE TEMPLATE, status and
 * duration. Never the URL, the query, the subject or the body — an
 * identifier in a log line outlives the request that carried it.
 *
 * The request id is taken from `X-Request-ID` when it looks like one, and
 * minted otherwise; it is echoed back so a client can quote it.
 */

import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { logger } from "../utils/logger";

const SAFE_REQUEST_ID = /^[a-zA-Z0-9_.:-]{8,128}$/;

function requestId(req: Request): string {
  const incoming = req.header("x-request-id")?.trim();
  return incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
}

/** `baseUrl + route.path`, or `/unmatched` — never `req.path`, which carries ids. */
export function routeTemplate(req: Request): string {
  const route = req.route as { path?: unknown } | undefined;
  if (typeof route?.path !== "string") return "/unmatched";
  const joined = `${req.baseUrl ?? ""}${route.path}`;
  return joined.startsWith("/") ? joined : `/${joined}`;
}

export function requestObservability(req: Request, res: Response, next: NextFunction): void {
  const id = requestId(req);
  const startedAt = process.hrtime.bigint();
  res.setHeader("X-Request-ID", id);
  res.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    logger.info("HTTP request completed", {
      requestId: id,
      method: req.method.toUpperCase(),
      route: routeTemplate(req),
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
    });
  });
  next();
}
