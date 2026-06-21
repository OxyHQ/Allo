import { Router, Response } from "express";
import type { FilterQuery } from "mongoose";
import type { EncryptedMediaItem, MediaItem } from "@allo/shared-types";
import Message, { type IMessage } from "../models/Message";
import Conversation from "../models/Conversation";
import type { AlloAuthRequest as AuthRequest } from "../types/realtime";
import { getRequiredOxyUserId as getAuthenticatedUserId } from "@oxyhq/core/server";
import { sendErrorResponse, sendSuccessResponse, validateRequired } from "../utils/apiHelpers";
import { logger } from "../utils/logger";

const router = Router();

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 100;
const MESSAGE_CONTENT_ERROR = "Message must have either encrypted content or legacy plaintext";

type RequestBody = Record<string, unknown>;
type MediaKind = MediaItem["type"];
type MessageKind = NonNullable<IMessage["messageType"]>;

function isRecord(value: unknown): value is RequestBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRequestBody(value: unknown): RequestBody {
  return isRecord(value) ? value : {};
}

function getStringValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getOptionalString(value: unknown): string | undefined {
  return getStringValue(value) ?? undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function getPositiveInteger(value: unknown): number | null {
  const parsed = getOptionalNumber(value);
  if (parsed === undefined || parsed < 1 || !Number.isInteger(parsed)) {
    return null;
  }

  return parsed;
}

function getMessageLimit(value: unknown): number {
  const parsed = getPositiveInteger(value);
  if (parsed === null) {
    return DEFAULT_MESSAGE_LIMIT;
  }

  return Math.min(parsed, MAX_MESSAGE_LIMIT);
}

function getOptionalDate(value: unknown): Date | null | undefined {
  const rawValue = getStringValue(value);
  if (!rawValue) {
    return undefined;
  }

  const parsed = new Date(rawValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isMediaKind(value: unknown): value is MediaKind {
  return value === "image" || value === "video" || value === "audio" || value === "file";
}

function isMessageKind(value: unknown): value is MessageKind {
  return value === "text" || value === "media" || value === "system";
}

function applyOptionalMediaFields<T extends MediaItem | EncryptedMediaItem>(
  item: T,
  source: RequestBody
): T {
  const thumbnailUrl = getOptionalString(source.thumbnailUrl);
  const thumbnailCiphertext = getOptionalString(source.thumbnailCiphertext);
  const fileName = getOptionalString(source.fileName);
  const fileSize = getOptionalNumber(source.fileSize);
  const mimeType = getOptionalString(source.mimeType);
  const width = getOptionalNumber(source.width);
  const height = getOptionalNumber(source.height);
  const duration = getOptionalNumber(source.duration);

  return {
    ...item,
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    ...(thumbnailCiphertext ? { thumbnailCiphertext } : {}),
    ...(fileName ? { fileName } : {}),
    ...(fileSize !== undefined ? { fileSize } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
    ...(duration !== undefined ? { duration } : {}),
  };
}

function parseMediaItem(value: unknown): MediaItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = getStringValue(value.id);
  const url = getStringValue(value.url);

  if (!id || !url || !isMediaKind(value.type)) {
    return null;
  }

  return applyOptionalMediaFields(
    {
      id,
      type: value.type,
      url,
    },
    value
  );
}

function parseEncryptedMediaItem(value: unknown): EncryptedMediaItem | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = getStringValue(value.id);
  const ciphertext = getStringValue(value.ciphertext);

  if (!id || !ciphertext || !isMediaKind(value.type)) {
    return null;
  }

  return applyOptionalMediaFields(
    {
      id,
      type: value.type,
      ciphertext,
    },
    value
  );
}

function parseItemArray<T>(
  value: unknown,
  parseItem: (item: unknown) => T | null
): T[] | null | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const parsedItems: T[] = [];
  for (const item of value) {
    const parsedItem = parseItem(item);
    if (!parsedItem) {
      return null;
    }
    parsedItems.push(parsedItem);
  }

  return parsedItems;
}

function hasItems<T>(items: T[] | undefined): items is T[] {
  return items !== undefined && items.length > 0;
}

function getMessageKind(value: unknown, encryptedMedia: EncryptedMediaItem[] | undefined): MessageKind {
  if (isMessageKind(value)) {
    return value;
  }

  return hasItems(encryptedMedia) ? "media" : "text";
}

function mapToRecord<T>(map: Map<string, T>): Record<string, T> {
  const record: Record<string, T> = {};
  map.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
    const conversationId = getStringValue(req.query.conversationId);
    const limit = getMessageLimit(req.query.limit);
    const beforeDate = getOptionalDate(req.query.before);

    const validationError = validateRequired(conversationId, "conversationId");
    if (!conversationId) {
      return sendErrorResponse(res, 400, "Bad Request", validationError ?? "Missing conversationId parameter");
    }

    if (beforeDate === null) {
      return sendErrorResponse(res, 400, "Bad Request", "before must be a valid date");
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
    const query: FilterQuery<IMessage> = {
      conversationId,
      deletedAt: { $exists: false },
    };

    if (beforeDate) {
      query.createdAt = { $lt: beforeDate };
    }

    const messages = await Message.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Reverse to get chronological order
    messages.reverse();

    // Return messages as-is (encrypted or plaintext)
    // Client is responsible for decryption
    return sendSuccessResponse(res, 200, { messages });
  } catch (err) {
    logger.error("[Messages] Error fetching messages", err);
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
    logger.error("[Messages] Error fetching message", err);
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
    const body = getRequestBody(req.body);
    const conversationId = getStringValue(body.conversationId);
    const senderDeviceId = getPositiveInteger(body.senderDeviceId);
    const ciphertext = getOptionalString(body.ciphertext);
    const encryptedMedia = parseItemArray(body.encryptedMedia, parseEncryptedMediaItem);
    const encryptionVersion = getOptionalNumber(body.encryptionVersion);
    const text = getOptionalString(body.text);
    const media = parseItemArray(body.media, parseMediaItem);
    const replyTo = getOptionalString(body.replyTo);
    const fontSize = getOptionalNumber(body.fontSize);

    const validationError = validateRequired(conversationId, "conversationId");
    if (!conversationId) {
      return sendErrorResponse(res, 400, "Bad Request", validationError ?? "Missing conversationId parameter");
    }

    if (senderDeviceId === null) {
      return sendErrorResponse(res, 400, "Bad Request", "senderDeviceId is required");
    }

    if (encryptedMedia === null) {
      return sendErrorResponse(res, 400, "Bad Request", "encryptedMedia must contain valid encrypted media items");
    }

    if (media === null) {
      return sendErrorResponse(res, 400, "Bad Request", "media must contain valid media items");
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
    const hasEncrypted = Boolean(ciphertext) || hasItems(encryptedMedia);
    const hasLegacy = Boolean(text) || hasItems(media);

    if (!hasEncrypted && !hasLegacy) {
      return sendErrorResponse(res, 400, "Bad Request", MESSAGE_CONTENT_ERROR);
    }

    // Create message (encrypted or plaintext)
    const message = await Message.create({
      conversationId,
      senderId: userId,
      senderDeviceId,
      // Encrypted content
      ciphertext,
      encryptedMedia,
      encryptionVersion: encryptionVersion ?? 1,
      messageType: getMessageKind(body.messageType, encryptedMedia),
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
      : text || (hasItems(media) ? `Sent ${media.length} media file(s)` : "");
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

    // Emit real-time event to both conversation room AND all participant user rooms
    // This ensures users receive messages even when not viewing that conversation (like WhatsApp)
    const messagingNamespace = req.app.locals.realtime?.messagingNamespace;
    if (messagingNamespace) {
      // Convert message to plain object for socket emission
      const messageData = message.toObject();
      
      // Emit to conversation room (for active viewers)
      messagingNamespace.to(`conversation:${conversationId}`).emit("newMessage", messageData);
      logger.info(`[Messages] Emitted newMessage to conversation:${conversationId}`);
      
      // Also emit to all participant user rooms (so users receive messages globally)
      // This allows messages to appear in conversation list even when not viewing that conversation
      conversation.participants.forEach((participant) => {
        messagingNamespace.to(`user:${participant.userId}`).emit("newMessage", messageData);
        logger.info(`[Messages] Emitted newMessage to user:${participant.userId}`);
      });
    } else {
      logger.error("[Messages] Socket.IO unavailable; realtime message emit skipped");
    }

    return sendSuccessResponse(res, 201, message);
  } catch (err) {
    logger.error("[Messages] Error sending message", err);
    const errorMessage = getErrorMessage(err);
    if (errorMessage.includes("must have either text or media") || errorMessage.includes(MESSAGE_CONTENT_ERROR)) {
      return sendErrorResponse(res, 400, "Bad Request", errorMessage);
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
    const body = getRequestBody(req.body);
    const text = getStringValue(body.text);

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
    const messagingNamespace = req.app.locals.realtime?.messagingNamespace;
    if (messagingNamespace) {
      messagingNamespace.to(`conversation:${message.conversationId}`).emit("messageUpdated", message);
    }

    return sendSuccessResponse(res, 200, message);
  } catch (err) {
    logger.error("[Messages] Error editing message", err);
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
    const body = getRequestBody(req.body);
    const emoji = getStringValue(body.emoji);

    const validationError = validateRequired(emoji, "emoji");
    if (!emoji) {
      return sendErrorResponse(res, 400, "Bad Request", validationError ?? "Missing emoji parameter");
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
      message.reactions = new Map<string, string[]>();
    }
    const reactions = message.reactions;

    const currentReactions = reactions.get(emoji) || [];
    const hasReacted = currentReactions.includes(userId);

    if (hasReacted) {
      // Remove reaction
      reactions.set(
        emoji,
        currentReactions.filter((uid: string) => uid !== userId)
      );
    } else {
      // Add reaction
      reactions.set(emoji, [...currentReactions, userId]);
    }

    await message.save();

    // Convert Map to plain object for socket emission
    const reactionsObj = mapToRecord(reactions);

    // Emit real-time event
    const messagingNamespace = req.app.locals.realtime?.messagingNamespace;
    if (messagingNamespace) {
      messagingNamespace
        .to(`conversation:${message.conversationId}`)
        .emit("messageReactionUpdated", {
          messageId: message._id,
          emoji,
          userId,
          hasReacted: !hasReacted,
          reactions: reactionsObj,
        });
    }

    return sendSuccessResponse(res, 200, {
      messageId: message._id,
      emoji,
      hasReacted: !hasReacted,
      reactions: reactionsObj,
    });
  } catch (err) {
    logger.error("[Messages] Error updating reaction", err);
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
    const messagingNamespace = req.app.locals.realtime?.messagingNamespace;
    if (messagingNamespace) {
      messagingNamespace.to(`conversation:${message.conversationId}`).emit("messageDeleted", { id: message._id });
    }

    return sendSuccessResponse(res, 200, { id: message._id, deleted: true });
  } catch (err) {
    logger.error("[Messages] Error deleting message", err);
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
    logger.error("[Messages] Error marking message as read", err);
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
    logger.error("[Messages] Error marking message as delivered", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to mark message as delivered");
  }
});

export default router;
