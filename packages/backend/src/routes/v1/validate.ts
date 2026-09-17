/**
 * Zod at the edge, and nothing else.
 *
 * A body or query that does not satisfy its `@allo/shared-types` schema is a
 * `validation_failed` with the issues in `details`; the error handler in
 * `app.ts` does the serialising. Routes call these and never touch `req.body`
 * unparsed.
 */

import type { Request } from "express";
import type { ZodType, z } from "zod";
import { validationFailed } from "../../utils/httpErrors";

export function parseBody<S extends ZodType>(schema: S, req: Request): z.output<S> {
  const result = schema.safeParse(req.body);
  if (!result.success) throw validationFailed("The request body did not satisfy its schema", result.error.issues);
  return result.data;
}

export function parseQuery<S extends ZodType>(schema: S, req: Request): z.output<S> {
  const result = schema.safeParse(req.query);
  if (!result.success) throw validationFailed("The query did not satisfy its schema", result.error.issues);
  return result.data;
}

export function parseParam<S extends ZodType>(schema: S, value: unknown, name: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw validationFailed(`The ${name} parameter is malformed`, result.error.issues);
  return result.data;
}
