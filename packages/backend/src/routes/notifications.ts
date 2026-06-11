import { Router, Response } from "express";
import Notification from "../models/Notification";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import { sendErrorResponse, sendSuccessResponse } from "../utils/apiHelpers";

const router = Router();

/**
 * Notifications API
 * All routes require authentication
 */

router.use(requireAuth);

/**
 * GET /api/notifications
 * Get paginated notifications for the authenticated user
 * Query params: limit (default 20, max 100), offset (default 0), unreadOnly (optional)
 */
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const unreadOnly = req.query.unreadOnly === "true";

    const query: Record<string, any> = { recipientId: userId };
    if (unreadOnly) {
      query.read = false;
    }

    const [notifications, total] = await Promise.all([
      Notification.find(query)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .lean(),
      Notification.countDocuments(query),
    ]);

    return sendSuccessResponse(res, 200, {
      notifications,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + notifications.length < total,
      },
    });
  } catch (err) {
    console.error("[Notifications] Error fetching notifications:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch notifications");
  }
});

/**
 * GET /api/notifications/unread-count
 * Get unread notification count for the authenticated user
 */
router.get("/unread-count", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const count = await Notification.countDocuments({ recipientId: userId, read: false });
    return sendSuccessResponse(res, 200, { count });
  } catch (err) {
    console.error("[Notifications] Error fetching unread count:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch unread count");
  }
});

/**
 * PUT /api/notifications/read-all
 * Mark all of the authenticated user's notifications as read
 */
router.put("/read-all", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const result = await Notification.updateMany(
      { recipientId: userId, read: false },
      { $set: { read: true } }
    );
    return sendSuccessResponse(
      res,
      200,
      { modifiedCount: result.modifiedCount },
      "All notifications marked as read"
    );
  } catch (err) {
    console.error("[Notifications] Error marking all notifications as read:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to mark notifications as read");
  }
});

/**
 * PUT /api/notifications/:id/read
 * Mark a single notification as read
 */
router.put("/:id/read", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const notification = await Notification.findOneAndUpdate(
      { _id: id, recipientId: userId },
      { $set: { read: true } },
      { new: true }
    ).lean();

    if (!notification) {
      return sendErrorResponse(res, 404, "Not Found", "Notification not found");
    }

    return sendSuccessResponse(res, 200, notification);
  } catch (err) {
    console.error("[Notifications] Error marking notification as read:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to mark notification as read");
  }
});

/**
 * DELETE /api/notifications/:id
 * Delete a notification
 */
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const result = await Notification.findOneAndDelete({ _id: id, recipientId: userId });

    if (!result) {
      return sendErrorResponse(res, 404, "Not Found", "Notification not found");
    }

    return sendSuccessResponse(res, 200, { id, deleted: true });
  } catch (err) {
    console.error("[Notifications] Error deleting notification:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to delete notification");
  }
});

export default router;
