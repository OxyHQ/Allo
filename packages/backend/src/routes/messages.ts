/**
 * Messages — on Postgres.
 *
 * Every handler reads and writes through `db/messaging/messageRepository`, and
 * `utils/messageDto.ts` composes both the HTTP response and the socket payload
 * so the two cannot disagree.
 *
 * ## What the port removes rather than reproduces
 *
 * - **The two-save send.** Creating the message and updating the conversation
 *   (preview, `lastMessageAt`, everyone else's unread count) were independent
 *   `save()`s, so a failure between them left a stored message the conversation
 *   list never showed. `createMessage` commits all of it in one transaction.
 *
 * - **A lost unread count.** The increment is evaluated in SQL. A
 *   read-modify-write here would write `stale + 1` over the zero that
 *   `markConversationRead` had just committed, making the badge reappear on a
 *   conversation the user has read.
 *
 * - **Two check-then-write windows.** Editing and deleting read the document,
 *   mutated it and saved, so a delete landing in between could resurrect a
 *   message's text. Both are now single statements whose `WHERE` carries the
 *   ownership and not-deleted conditions, and a `null` result is the single 404
 *   covering "no such message", "not yours" and "already deleted" — which
 *   deliberately tells an unauthorized caller which of the three it was.
 *
 * - **Reactions read whole and written whole.** The `Map<emoji, userId[]>` was
 *   edited in memory and saved back, so two people reacting at once wrote over
 *   each other and one reaction simply vanished. `toggleReaction` deletes or
 *   inserts a single row against a unique index.
 *
 * One behaviour genuinely differs, and it is forced rather than chosen:
 * removing the last reactor for an emoji now drops that emoji's key instead of
 * leaving it as `[]`, because the table's grain is (message, user, emoji) and
 * "zero reactors" has no row to be. A client must treat a missing key and an
 * empty array as the same thing.
 */

import { Router, Response } from "express";
import type { EncryptedMediaItem, MediaItem, MessageKind } from "@allo/shared-types";
import type { AlloAuthRequest as AuthRequest } from "../types/realtime";
import { getRequiredOxyUserId as getAuthenticatedUserId } from "@oxyhq/core/server";
import { sendErrorResponse, sendSuccessResponse, validateRequired } from "../utils/apiHelpers";
import { logger } from "../utils/logger";
import { getDb } from "../db";
import {
  findConversationForParticipant,
  isConversationParticipant,
} from "../db/messaging/conversationRepository";
import {
  createMessage,
  editMessageText,
  findMessageById,
  listConversationMessages,
  markMessageDelivered,
  markMessageRead,
  softDeleteMessage,
  toggleReaction,
} from "../db/messaging/messageRepository";
import { toMessageDto } from "../utils/messageDto";

const router = Router();

const DEFAULT_MESSAGE_LIMIT = 50;
const MAX_MESSAGE_LIMIT = 100;
const MESSAGE_CONTENT_ERROR = "Message must have either encrypted content or legacy plaintext";

type RequestBody = Record<string, unknown>;
type MediaKind = MediaItem["type"];

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

    // Verify user is a participant. "Not found" and "not yours" are the same
    // answer, so neither confirms the conversation exists.
    if (!(await isConversationParticipant(getDb(), conversationId, userId))) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    // Oldest-first, soft-deleted excluded — the repository does the reversing
    // the route used to do by hand.
    const messages = await listConversationMessages(getDb(), {
      conversationId,
      limit,
      ...(beforeDate ? { before: beforeDate } : {}),
    });

    // Return messages as-is (encrypted or plaintext)
    // Client is responsible for decryption
    return sendSuccessResponse(res, 200, { messages: messages.map(toMessageDto) });
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

    // Soft-deleted messages included, as `findById` was: the row is fetched to
    // learn its `conversationId` before deciding whether the caller may see it.
    const message = await findMessageById(getDb(), id);

    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found");
    }

    // Verify user is a participant in the conversation
    if (!(await isConversationParticipant(getDb(), message.conversationId, userId))) {
      return sendErrorResponse(res, 403, "Forbidden", "Access denied");
    }

    return sendSuccessResponse(res, 200, toMessageDto(message));
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

    // The full record rather than the boolean: this is the one path that emits
    // to every participant's own room, so it needs the membership list.
    const conversation = await findConversationForParticipant(getDb(), conversationId, userId);

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    // Check if message has encrypted content or legacy plaintext
    const hasEncrypted = Boolean(ciphertext) || hasItems(encryptedMedia);
    const hasLegacy = Boolean(text) || hasItems(media);

    if (!hasEncrypted && !hasLegacy) {
      return sendErrorResponse(res, 400, "Bad Request", MESSAGE_CONTENT_ERROR);
    }

    /**
     * The conversation-list preview, composed HERE because what it may contain
     * is a privacy decision: an encrypted message stores a placeholder and never
     * its plaintext. The repository takes it rather than deriving it, so that
     * policy is not made once per future caller.
     */
    const lastMessagePreview = ciphertext
      ? "[Encrypted]"
      : text || (hasItems(media) ? `Sent ${media.length} media file(s)` : "");

    // The message row, the sender's own delivery receipt, the conversation
    // preview and everyone else's unread count — one transaction.
    const message = await createMessage(getDb(), {
      conversationId,
      senderId: userId,
      senderDeviceId,
      ciphertext: ciphertext ?? null,
      encryptedMedia,
      encryptionVersion: encryptionVersion ?? 1,
      messageType: getMessageKind(body.messageType, encryptedMedia),
      // Legacy plaintext (deprecated)
      text: text ?? null,
      media,
      replyTo: replyTo ?? null,
      fontSize: fontSize ?? null,
      lastMessagePreview,
    });

    const messageData = toMessageDto(message);

    // Emit real-time event to both conversation room AND all participant user rooms
    // This ensures users receive messages even when not viewing that conversation (like WhatsApp)
    const messagingNamespace = req.app.locals.realtime?.messagingNamespace;
    if (messagingNamespace) {
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

    return sendSuccessResponse(res, 201, messageData);
  } catch (err) {
    logger.error("[Messages] Error sending message", err);
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

    // Ownership and not-deleted are in the UPDATE's own WHERE, so there is no
    // window between checking and writing.
    const message = await editMessageText(getDb(), { messageId: id, senderId: userId, text });

    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found or you don't have permission to edit it");
    }

    const messageData = toMessageDto(message);

    // Emit real-time event
    const messagingNamespace = req.app.locals.realtime?.messagingNamespace;
    if (messagingNamespace) {
      messagingNamespace.to(`conversation:${message.conversationId}`).emit("messageUpdated", messageData);
    }

    return sendSuccessResponse(res, 200, messageData);
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

    const message = await findMessageById(getDb(), id);
    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found");
    }

    // Verify user is a participant in the conversation
    if (!(await isConversationParticipant(getDb(), message.conversationId, userId))) {
      return sendErrorResponse(res, 403, "Forbidden", "You are not a participant in this conversation");
    }

    // The toggle and the re-read run in one transaction, so the map returned is
    // the state this toggle produced rather than one a concurrent reaction has
    // already moved past.
    const { hasReacted, reactions } = await toggleReaction(getDb(), id, userId, emoji);

    // Emit real-time event
    const messagingNamespace = req.app.locals.realtime?.messagingNamespace;
    if (messagingNamespace) {
      messagingNamespace
        .to(`conversation:${message.conversationId}`)
        .emit("messageReactionUpdated", {
          messageId: message.id,
          emoji,
          userId,
          hasReacted,
          reactions,
        });
    }

    return sendSuccessResponse(res, 200, {
      messageId: message.id,
      emoji,
      hasReacted,
      reactions,
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

    // `isNull(deletedAt)` in the same statement is what makes a second delete a
    // 404 rather than a silent success that moves the tombstone's timestamp.
    const deleted = await softDeleteMessage(getDb(), id, userId);

    if (!deleted) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found or already deleted");
    }

    // Emit real-time event
    const messagingNamespace = req.app.locals.realtime?.messagingNamespace;
    if (messagingNamespace) {
      messagingNamespace.to(`conversation:${deleted.conversationId}`).emit("messageDeleted", { id: deleted.id });
    }

    return sendSuccessResponse(res, 200, { id: deleted.id, deleted: true });
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

    const message = await findMessageById(getDb(), id);

    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found");
    }

    // Verify user is a participant
    if (!(await isConversationParticipant(getDb(), message.conversationId, userId))) {
      return sendErrorResponse(res, 403, "Forbidden", "Access denied");
    }

    // The timestamp is overwritten on a repeat, which is what
    // `readBy.set(userId, new Date())` did.
    const updated = await markMessageRead(getDb(), id, userId);

    if (!updated) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found");
    }

    return sendSuccessResponse(res, 200, toMessageDto(updated));
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

    const message = await findMessageById(getDb(), id);

    if (!message) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found");
    }

    // Verify user is a participant
    if (!(await isConversationParticipant(getDb(), message.conversationId, userId))) {
      return sendErrorResponse(res, 403, "Forbidden", "Access denied");
    }

    // First delivery wins, which is what pushing only `if (!includes(userId))`
    // did — deliberately different from the read receipt above.
    const updated = await markMessageDelivered(getDb(), id, userId);

    if (!updated) {
      return sendErrorResponse(res, 404, "Not Found", "Message not found");
    }

    return sendSuccessResponse(res, 200, toMessageDto(updated));
  } catch (err) {
    logger.error("[Messages] Error marking message as delivered", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to mark message as delivered");
  }
});

export default router;
