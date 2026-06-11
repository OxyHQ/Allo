import { Router, Response } from "express";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import { sendErrorResponse, sendSuccessResponse } from "../utils/apiHelpers";
import { logger } from "../utils/logger";
import UserSettings from "../models/UserSettings";
import {
  presenceRegistry,
  parseBootstrapUserIds,
  resolveHiddenUserIds,
  buildBootstrapResult,
  MAX_PRESENCE_BOOTSTRAP_IDS,
} from "../utils/presence";

const router = Router();

/**
 * GET /api/presence?userIds=a,b,c
 *
 * Bootstraps current presence for up to `MAX_PRESENCE_BOOTSTRAP_IDS` users so a
 * client that just opened a screen has accurate dots/last-seen before the first
 * live `presence:update` arrives. Honors each subject's privacy: a user with
 * `privacy.showOnlineStatus === false` is always reported offline with no
 * `lastSeenAt`, regardless of their live connection state.
 */
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    // Authentication is enforced by the router mount; resolve to fail fast on a
    // malformed request and to keep parity with the other authenticated routes.
    getAuthenticatedUserId(req);

    const ids = parseBootstrapUserIds(req.query.userIds, MAX_PRESENCE_BOOTSTRAP_IDS);
    if (ids.length === 0) {
      return sendSuccessResponse(res, 200, {});
    }

    const settingsDocs = await UserSettings.find(
      { oxyUserId: { $in: ids } },
      { oxyUserId: 1, "privacy.showOnlineStatus": 1 }
    ).lean();

    const hidden = resolveHiddenUserIds(settingsDocs);
    const result = buildBootstrapResult(ids, presenceRegistry, hidden);

    return sendSuccessResponse(res, 200, result);
  } catch (err) {
    logger.error("Failed to resolve presence bootstrap", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to resolve presence");
  }
});

export default router;
