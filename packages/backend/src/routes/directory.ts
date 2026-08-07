import { Router, type Response } from "express";
import type { OxyAuthRequest } from "@oxyhq/core/server";
import * as z from "zod";

import { isOxyUserId } from "../services/bridges/matrixIdentity";
import type { OxyDirectoryService } from "../services/oxy/OxyDirectoryService";
import { sendErrorResponse, sendSuccessResponse } from "../utils/apiHelpers";
import { getErrorMessage, isOxyUserNotFound } from "../utils/oxyUserDisplay";
import { logger } from "../utils/logger";

/**
 * `GET /api/directory/*` — who somebody is, answered by this backend instead of
 * by Oxy directly.
 *
 * See `services/oxy/OxyDirectoryService.ts` for why these five exist and why
 * they need no service credential. This file is the boundary: it validates what
 * arrives, maps an upstream failure onto a status, and never lets an Oxy `User`
 * out unprojected.
 *
 * ## Authenticated, deliberately, even though Oxy answers anonymously
 *
 * Every underlying Oxy route is public, so these could be too. They are not,
 * because a public profile lookup on `api.allo.you` would be an unauthenticated
 * enumeration endpoint pointed at Oxy's whole user base with Allo's own IP
 * reputation in front of it. Mounted inside the authenticated router, the
 * per-user rate limiter has a user to key on and the caller is somebody.
 *
 * ## Why an id is refused rather than passed through
 *
 * `GET /users/:userId` on Oxy also accepts a public key, and `resolveUserId`
 * there maps it. Allo has never had one: every id it holds is a 24-character
 * ObjectId, and it is the SAME shape the Matrix authentication boundary
 * requires of an MXID localpart — so it is checked with the same function,
 * `isOxyUserId`, rather than with a second regular expression that could come
 * to a different conclusion.
 */

/** Oxy handles. Bounded, and without the `@` — see `lib/profile/handle.ts`. */
const usernameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "must be a bare handle: letters, digits, dot, underscore and hyphen, and no leading @",
  );

const oxyUserIdSchema = z
  .string()
  .trim()
  .refine(isOxyUserId, "must be a 24-character hexadecimal Oxy account id");

/**
 * The same ceiling `@oxyhq/core` chunks at, so one request here is one request
 * upstream. Asking for more would not fail — it would quietly become several
 * upstream calls, of which one can drop out.
 */
const MAX_USERS_BY_IDS = 100;

const usersByIdsSchema = z.object({
  ids: z.array(oxyUserIdSchema).min(1).max(MAX_USERS_BY_IDS),
});

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 50;

const searchSchema = z.object({
  query: z.string().trim().min(1).max(100),
  limit: z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

/**
 * An Oxy asset id, bounded and with no path characters in it.
 *
 * The id is interpolated into a CDN URL. `@oxyhq/core` percent-encodes it, so
 * this is not the thing standing between us and a traversal — it is what stops
 * this endpoint from minting a URL for any string a caller invents, which is
 * how an avatar endpoint becomes an open redirect generator.
 */
const fileIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "must be an Oxy asset id");

const variantSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9_-]+$/, "must be an asset variant name")
  .optional();

export interface DirectoryRoutesOptions {
  readonly service: OxyDirectoryService;
}

/** The first zod issue, as a message. Field paths only, never values. */
function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid request";
  const path = issue.path.join(".");
  return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
}

/**
 * Turns an Oxy SDK failure into a status.
 *
 * A 404 upstream is a 404 here. Everything else is 502: the request was fine,
 * the dependency was not, and answering 500 would send the operator looking in
 * this codebase for a fault that is not in it.
 */
function respondToUpstreamFailure(res: Response, operation: string, error: unknown): Response {
  if (isOxyUserNotFound(error)) {
    return sendErrorResponse(res, 404, "Not Found", "No such account");
  }
  logger.error(`[Directory] ${operation} failed`, {
    reason: getErrorMessage(error) ?? "unknown",
  });
  return sendErrorResponse(res, 502, "Bad Gateway", "The directory is temporarily unavailable");
}

export function createDirectoryRoutes(options: DirectoryRoutesOptions): Router {
  const router = Router();
  const { service } = options;

  /** `GET /api/directory/profiles/username/:username` — a profile by handle. */
  router.get("/profiles/username/:username", async (req: OxyAuthRequest, res: Response) => {
    const parsed = usernameSchema.safeParse(req.params.username);
    if (!parsed.success) {
      return sendErrorResponse(res, 400, "Bad Request", firstIssue(parsed.error));
    }

    try {
      return sendSuccessResponse(res, 200, await service.profileByUsername(parsed.data));
    } catch (error) {
      return respondToUpstreamFailure(res, "profileByUsername", error);
    }
  });

  /**
   * `GET /api/directory/profiles/search?query=&limit=&offset=`
   *
   * Declared before `/users/:userId` has no bearing here — the paths do not
   * overlap — but it IS declared before the by-ids route below, which shares
   * the `/users` prefix and would otherwise be shadowed by `:userId`.
   */
  router.get("/profiles/search", async (req: OxyAuthRequest, res: Response) => {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) {
      return sendErrorResponse(res, 400, "Bad Request", firstIssue(parsed.error));
    }

    try {
      const { query, limit, offset } = parsed.data;
      const result = await service.searchProfiles(query, { limit, offset });
      return sendSuccessResponse(res, 200, result);
    } catch (error) {
      return respondToUpstreamFailure(res, "searchProfiles", error);
    }
  });

  /**
   * `POST /api/directory/users/by-ids` — several accounts in one call.
   *
   * A POST for a read, because the body is up to a hundred ids and a query
   * string that long is at the mercy of every proxy between here and the
   * client. It matches the shape of Oxy's own `POST /users/by-ids`.
   *
   * Declared BEFORE `/users/:userId` so that `by-ids` is not captured as an id.
   * It would be refused as a malformed id rather than mis-served, but the 400
   * would name the wrong problem.
   */
  router.post("/users/by-ids", async (req: OxyAuthRequest, res: Response) => {
    const parsed = usersByIdsSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendErrorResponse(res, 400, "Bad Request", firstIssue(parsed.error));
    }

    try {
      const users = await service.usersByIds(parsed.data.ids);
      /**
       * Fewer users than ids is normal and is not an error: an id can name a
       * deleted account. The caller maps by `id` — nothing is padded out with a
       * placeholder, because a placeholder is indistinguishable from an answer.
       */
      return sendSuccessResponse(res, 200, { users });
    } catch (error) {
      return respondToUpstreamFailure(res, "usersByIds", error);
    }
  });

  /** `GET /api/directory/users/:userId` — one account by id. */
  router.get("/users/:userId", async (req: OxyAuthRequest, res: Response) => {
    const parsed = oxyUserIdSchema.safeParse(req.params.userId);
    if (!parsed.success) {
      return sendErrorResponse(res, 400, "Bad Request", firstIssue(parsed.error));
    }

    try {
      return sendSuccessResponse(res, 200, await service.userById(parsed.data));
    } catch (error) {
      return respondToUpstreamFailure(res, "userById", error);
    }
  });

  /**
   * `GET /api/directory/assets/:fileId/url?variant=` — an avatar's address.
   *
   * The only one of the five that reaches nothing: `getFileDownloadUrl` is a
   * pure string builder over the Oxy CDN origin. It exists as an endpoint
   * anyway because an app with no Oxy SDK does not know that origin. Most
   * avatars should never need it — every {@link DirectoryUser} this router
   * returns already carries `avatarUrl` — and it is here for the id that
   * arrives from somewhere other than a directory lookup.
   */
  router.get("/assets/:fileId/url", (req: OxyAuthRequest, res: Response) => {
    const fileId = fileIdSchema.safeParse(req.params.fileId);
    if (!fileId.success) {
      return sendErrorResponse(res, 400, "Bad Request", firstIssue(fileId.error));
    }

    const variant = variantSchema.safeParse(req.query.variant);
    if (!variant.success) {
      return sendErrorResponse(res, 400, "Bad Request", firstIssue(variant.error));
    }

    return sendSuccessResponse(res, 200, { url: service.assetUrl(fileId.data, variant.data) });
  });

  return router;
}
