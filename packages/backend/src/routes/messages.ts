import { Router, Response } from "express";
import Message from "../models/Message";
import Conversation from "../models/Conversation";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import { sendErrorResponse, sendSuccessResponse, validateRequired } from "../utils/apiHelpers";

const router = Router();

/**
 * Messages API
 * All routes require authentication
 */

/**
 * GET /api/messages
 * Get messages for a conversation
 * Returns encrypted messages - client must decrypt them
 */
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { conversationId, limit = 50, before } = req.query;

    const validationError = validateRequired(conversationId as string, "conversationId");
    if (validationError) {
      return sendErrorResponse(res, 400, "Bad Request", validationError);
    }

    // Verify user is a participant
    const conversation = await Conversation.findOne({
      _id: conversationId,
      "participants.userId": userId,
    });

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    // Build query
    const query: any = {
      conversationId: conversationId as string,
      deletedAt: { $exists: false },
    };

    if (before) {
      query.createdAt = { $lt: new Date(before as string) };
    }

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .lean();

    // Reverse to get chronological order
    messages.reverse();

    // Return messages as-is (encrypted or plaintext)
    // Client is responsible for decryption
    return sendSuccessResponse(res, 200, { messages });
  } catch (err) {
    console.error("[Messages] Error fetching messages:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch messages");
  }
});

/**
 * GET /api/messages/:id
 * Get a specific message by ID
 */
router.get("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const message = await Message.findById(id).lean();

    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found");
    }

    // Verify user is a participant in the conversation
    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      "participants.userId": userId,
    });

    if (!conversation) {
      return sendErrorResponse(res, 403, "Forbidden", "Access denied");
    }

    return sendSuccessResponse(res, 200, message);
  } catch (err) {
    console.error("[Messages] Error fetching message:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch message");
  }
});

/**
 * POST /api/messages
 * Send a new message (encrypted or plaintext)
 */
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const {
      conversationId,
      senderDeviceId,
      // Encrypted content
      ciphertext,
      encryptedMedia,
      encryptionVersion,
      messageType,
      // Legacy plaintext (for backward compatibility)
      text,
      media,
      replyTo,
      fontSize,
    } = req.body;

    const validationError = validateRequired(conversationId, "conversationId");
    if (validationError) {
      return sendErrorResponse(res, 400, "Bad Request", validationError);
    }

    if (!senderDeviceId) {
      return sendErrorResponse(res, 400, "Bad Request", "senderDeviceId is required");
    }

    // Verify user is a participant
    const conversation = await Conversation.findOne({
      _id: conversationId,
      "participants.userId": userId,
    });

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    // Check if message has encrypted content or legacy plaintext
    const hasEncrypted = ciphertext || (encryptedMedia && encryptedMedia.length > 0);
    const hasLegacy = text || (media && media.length > 0);

    if (!hasEncrypted && !hasLegacy) {
      return sendErrorResponse(res, 400, "Bad Request", "Message must have either encrypted content or legacy plaintext");
    }

    // Create message (encrypted or plaintext)
    const message = await Message.create({
      conversationId,
      senderId: userId,
      senderDeviceId: Number(senderDeviceId),
      // Encrypted content
      ciphertext,
      encryptedMedia,
      encryptionVersion: encryptionVersion || 1,
      messageType: messageType || (encryptedMedia ? "media" : "text"),
      // Legacy plaintext (deprecated)
      text,
      media,
      replyTo,
      fontSize,
      deliveredTo: [userId], // Sender has received their own message
    });

    // Update conversation's last message
    conversation.lastMessageAt = new Date();
    // For encrypted messages, don't store plaintext preview
    const lastMessageText = ciphertext
      ? "[Encrypted]"
      : text || (media && media.length > 0 ? `Sent ${media.length} media file(s)` : "");
    conversation.lastMessage = {
      text: lastMessageText,
      senderId: userId,
      timestamp: new Date(),
    };

    // Increment unread counts for all participants except sender
    conversation.participants.forEach((participant) => {
      if (participant.userId !== userId) {
        const currentCount = conversation.unreadCounts.get(participant.userId) || 0;
        conversation.unreadCounts.set(participant.userId, currentCount + 1);
      }
    });

    await conversation.save();

    // Emit real-time event
    const io = (global as any).io;
    if (io) {
      const messagingNamespace = io.of("/messaging");
      messagingNamespace.to(`conversation:${conversationId}`).emit("newMessage", message);
    }

    return sendSuccessResponse(res, 201, message);
  } catch (err: any) {
    console.error("[Messages] Error sending message:", err);
    if (err.message?.includes("must have either text or media")) {
      return sendErrorResponse(res, 400, "Bad Request", err.message);
    }
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to send message");
  }
});

/**
 * PUT /api/messages/:id
 * Edit a message
 */
router.put("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;
    const { text } = req.body;

    if (!text) {
      return sendErrorResponse(res, 400, "Bad Request", "Text is required");
    }

    const message = await Message.findOne({
      _id: id,
      senderId: userId,
      deletedAt: { $exists: false },
    });

    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found or you don't have permission to edit it");
    }

    message.text = text;
    message.editedAt = new Date();
    await message.save();

    // Emit real-time event
    const io = (global as any).io;
    if (io) {
      const messagingNamespace = io.of("/messaging");
      messagingNamespace.to(`conversation:${message.conversationId}`).emit("messageUpdated", message);
    }

    return sendSuccessResponse(res, 200, message);
  } catch (err) {
    console.error("[Messages] Error editing message:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to edit message");
  }
});

/**
 * POST /api/messages/:id/reactions
 * Add or remove a reaction to a message
 */
router.post("/:id/reactions", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;
    const { emoji } = req.body;

    const validationError = validateRequired(emoji, "emoji");
    if (validationError) {
      return sendErrorResponse(res, 400, "Bad Request", validationError);
    }

    const message = await Message.findById(id);
    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found");
    }

    // Verify user is a participant in the conversation
    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      "participants.userId": userId,
    });

    if (!conversation) {
      return sendErrorResponse(res, 403, "Forbidden", "You are not a participant in this conversation");
    }

    // Initialize reactions if not exists
    if (!message.reactions) {
      message.reactions = new Map();
    }

    const currentReactions = message.reactions.get(emoji) || [];
    const hasReacted = currentReactions.includes(userId);

    if (hasReacted) {
      // Remove reaction
      message.reactions.set(
        emoji,
        currentReactions.filter((uid) => uid !== userId)
      );
    } else {
      // Add reaction
      message.reactions.set(emoji, [...currentReactions, userId]);
    }

    await message.save();

    // Emit real-time event
    const io = (global as any).io;
    if (io) {
      const messagingNamespace = io.of("/messaging");
      messagingNamespace
        .to(`conversation:${message.conversationId}`)
        .emit("messageReactionUpdated", {
          messageId: message._id,
          emoji,
          userId,
          hasReacted: !hasReacted,
          reactions: Object.fromEntries(message.reactions),
        });
    }

    return sendSuccessResponse(res, 200, {
      messageId: message._id,
      emoji,
      hasReacted: !hasReacted,
      reactions: Object.fromEntries(message.reactions),
    });
  } catch (err) {
    console.error("[Messages] Error updating reaction:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to update reaction");
  }
});

/**
 * DELETE /api/messages/:id
 * Delete a message (soft delete)
 */
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const message = await Message.findOne({
      _id: id,
      senderId: userId,
      deletedAt: { $exists: false },
    });

    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found or already deleted");
    }

    message.deletedAt = new Date();
    await message.save();

    // Emit real-time event
    const io = (global as any).io;
    if (io) {
      const messagingNamespace = io.of("/messaging");
      messagingNamespace.to(`conversation:${message.conversationId}`).emit("messageDeleted", { id: message._id });
    }

    return sendSuccessResponse(res, 200, { id: message._id, deleted: true });
  } catch (err) {
    console.error("[Messages] Error deleting message:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to delete message");
  }
});

/**
 * POST /api/messages/:id/read
 * Mark a message as read
 */
router.post("/:id/read", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const message = await Message.findById(id);

    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found");
    }

    // Verify user is a participant
    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      "participants.userId": userId,
    });

    if (!conversation) {
      return sendErrorResponse(res, 403, "Forbidden", "Access denied");
    }

    // Mark as read
    message.readBy.set(userId, new Date());
    await message.save();

    return sendSuccessResponse(res, 200, message);
  } catch (err) {
    console.error("[Messages] Error marking message as read:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to mark message as read");
  }
});

/**
 * POST /api/messages/:id/delivered
 * Mark a message as delivered
 */
router.post("/:id/delivered", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const message = await Message.findById(id);

    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found");
    }

    // Verify user is a participant
    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      "participants.userId": userId,
    });

    if (!conversation) {
      return sendErrorResponse(res, 403, "Forbidden", "Access denied");
    }

    // Mark as delivered
    if (!message.deliveredTo.includes(userId)) {
      message.deliveredTo.push(userId);
      await message.save();
    }

    return sendSuccessResponse(res, 200, message);
  } catch (err) {
    console.error("[Messages] Error marking message as delivered:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to mark message as delivered");
  }
});

export default router;

