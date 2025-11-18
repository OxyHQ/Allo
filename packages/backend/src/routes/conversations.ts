import { Router, Response } from "express";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import { sendErrorResponse, sendSuccessResponse, validateRequired } from "../utils/apiHelpers";

const router = Router();

/**
 * Conversations API
 * All routes require authentication
 */

/**
 * GET /api/conversations
 * Get all conversations for the authenticated user
 */
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { limit = 50, offset = 0 } = req.query;

    const conversations = await Conversation.find({
      "participants.userId": userId,
      archivedBy: { $ne: userId },
    })
      .sort({ lastMessageAt: -1, createdAt: -1 })
      .limit(Number(limit))
      .skip(Number(offset))
      .lean();

    return sendSuccessResponse(res, 200, { conversations });
  } catch (err) {
    console.error("[Conversations] Error fetching conversations:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch conversations");
  }
});

/**
 * GET /api/conversations/:id
 * Get a specific conversation by ID
 */
router.get("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const validationError = validateRequired(id, "id");
    if (validationError) {
      return sendErrorResponse(res, 400, "Bad Request", validationError);
    }

    const conversation = await Conversation.findOne({
      _id: id,
      "participants.userId": userId,
    }).lean();

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    return sendSuccessResponse(res, 200, conversation);
  } catch (err) {
    console.error("[Conversations] Error fetching conversation:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch conversation");
  }
});

/**
 * POST /api/conversations
 * Create a new conversation
 */
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { type = "direct", participantIds, name, description, avatar } = req.body;

    if (!participantIds || !Array.isArray(participantIds) || participantIds.length < 1) {
      return sendErrorResponse(res, 400, "Bad Request", "At least one participant is required");
    }

    // Ensure current user is included
    const allParticipants = Array.from(new Set([userId, ...participantIds]));

    if (type === "direct" && allParticipants.length !== 2) {
      return sendErrorResponse(
        res,
        400,
        "Bad Request",
        "Direct conversations must have exactly 2 participants"
      );
    }

    // Check if direct conversation already exists
    if (type === "direct") {
      const existing = await Conversation.findOne({
        type: "direct",
        "participants.userId": { $all: allParticipants },
        "participants.2": { $exists: false }, // Exactly 2 participants
      }).lean();

      if (existing) {
        return sendSuccessResponse(res, 200, existing);
      }
    }

    const participants = allParticipants.map((pid) => ({
      userId: pid,
      role: pid === userId ? "admin" : "member",
      joinedAt: new Date(),
    }));

    const conversation = await Conversation.create({
      type,
      participants,
      name: type === "group" ? name : undefined,
      description: type === "group" ? description : undefined,
      avatar: type === "group" ? avatar : undefined,
      createdBy: userId,
      unreadCounts: {},
    });

    return sendSuccessResponse(res, 201, conversation);
  } catch (err: any) {
    console.error("[Conversations] Error creating conversation:", err);
    if (err.message?.includes("must have exactly 2 participants")) {
      return sendErrorResponse(res, 400, "Bad Request", err.message);
    }
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to create conversation");
  }
});

/**
 * PUT /api/conversations/:id
 * Update a conversation (name, description, avatar for groups)
 */
router.put("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;
    const { name, description, avatar } = req.body;

    const conversation = await Conversation.findOne({
      _id: id,
      "participants.userId": userId,
    });

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    if (conversation.type === "group") {
      if (name !== undefined) conversation.name = name;
      if (description !== undefined) conversation.description = description;
      if (avatar !== undefined) conversation.avatar = avatar;
    }

    await conversation.save();
    return sendSuccessResponse(res, 200, conversation);
  } catch (err) {
    console.error("[Conversations] Error updating conversation:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to update conversation");
  }
});

/**
 * POST /api/conversations/:id/participants
 * Add participants to a group conversation
 */
router.post("/:id/participants", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;
    const { participantIds } = req.body;

    if (!participantIds || !Array.isArray(participantIds) || participantIds.length === 0) {
      return sendErrorResponse(res, 400, "Bad Request", "At least one participant ID is required");
    }

    const conversation = await Conversation.findOne({
      _id: id,
      "participants.userId": userId,
      type: "group",
    });

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Group conversation not found");
    }

    const existingUserIds = conversation.participants.map((p) => p.userId);
    const newParticipants = participantIds
      .filter((pid: string) => !existingUserIds.includes(pid))
      .map((pid: string) => ({
        userId: pid,
        role: "member",
        joinedAt: new Date(),
      }));

    if (newParticipants.length > 0) {
      conversation.participants.push(...newParticipants);
      await conversation.save();
    }

    return sendSuccessResponse(res, 200, conversation);
  } catch (err) {
    console.error("[Conversations] Error adding participants:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to add participants");
  }
});

/**
 * DELETE /api/conversations/:id/participants/:participantId
 * Remove a participant from a group conversation
 */
router.delete("/:id/participants/:participantId", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id, participantId } = req.params;

    const conversation = await Conversation.findOne({
      _id: id,
      "participants.userId": userId,
      type: "group",
    });

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Group conversation not found");
    }

    if (participantId === userId) {
      return sendErrorResponse(res, 400, "Bad Request", "Cannot remove yourself. Use leave endpoint instead.");
    }

    conversation.participants = conversation.participants.filter((p) => p.userId !== participantId);

    if (conversation.participants.length < 2) {
      return sendErrorResponse(
        res,
        400,
        "Bad Request",
        "Cannot remove participant. Group must have at least 2 members."
      );
    }

    await conversation.save();
    return sendSuccessResponse(res, 200, conversation);
  } catch (err) {
    console.error("[Conversations] Error removing participant:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to remove participant");
  }
});

/**
 * POST /api/conversations/:id/archive
 * Archive a conversation
 */
router.post("/:id/archive", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const conversation = await Conversation.findOne({
      _id: id,
      "participants.userId": userId,
    });

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    if (!conversation.archivedBy.includes(userId)) {
      conversation.archivedBy.push(userId);
      await conversation.save();
    }

    return sendSuccessResponse(res, 200, conversation);
  } catch (err) {
    console.error("[Conversations] Error archiving conversation:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to archive conversation");
  }
});

/**
 * POST /api/conversations/:id/unarchive
 * Unarchive a conversation
 */
router.post("/:id/unarchive", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const conversation = await Conversation.findOne({
      _id: id,
      "participants.userId": userId,
    });

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    conversation.archivedBy = conversation.archivedBy.filter((id) => id !== userId);
    await conversation.save();

    return sendSuccessResponse(res, 200, conversation);
  } catch (err) {
    console.error("[Conversations] Error unarchiving conversation:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to unarchive conversation");
  }
});

/**
 * POST /api/conversations/:id/mark-read
 * Mark conversation as read
 */
router.post("/:id/mark-read", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const conversation = await Conversation.findOne({
      _id: id,
      "participants.userId": userId,
    });

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    // Update participant's lastReadAt
    const participant = conversation.participants.find((p) => p.userId === userId);
    if (participant) {
      participant.lastReadAt = new Date();
    }

    // Reset unread count
    conversation.unreadCounts.set(userId, 0);
    await conversation.save();

    return sendSuccessResponse(res, 200, conversation);
  } catch (err) {
    console.error("[Conversations] Error marking conversation as read:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to mark conversation as read");
  }
});

export default router;

