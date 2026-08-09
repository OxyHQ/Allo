/**
 * Conversations — on Postgres.
 *
 * Every handler reads and writes through `db/messaging/conversationRepository`,
 * and `utils/conversationDto.ts` is where rows become a response — including the
 * `unreadCounts` map, which no longer exists as a stored field and is
 * reassembled from the participant rows.
 *
 * ## What the port removes rather than reproduces
 *
 * - **`archivedBy`.** It was a list of user ids on the conversation, and it was
 *   only ever a server-side FILTER (`archivedBy: { $ne: userId }`). It is now
 *   `conversation_participants.archived_at` and the filter is the `isNull`
 *   predicate inside `listConversationsForUser`. Nothing reads it off a
 *   response, so it is dropped rather than reassembled.
 *
 * - **Two read-modify-write races.** Adding participants read the current
 *   members, filtered the request against them in memory and pushed the
 *   remainder, so two concurrent adds of the same person both saw an absence and
 *   both pushed; `addParticipants` converges on the unique index instead.
 *   Removing one counted the array in memory to enforce "a group keeps at least
 *   two", which is now the deferred constraint trigger — the only thing that can
 *   answer it without the race.
 *
 * - **`conversation.save()` on an untouched document.** `PUT /:id` with an empty
 *   body issued no write and left `updatedAt` alone; `updateConversationDetails`
 *   keeps that, rather than bumping the row for a request that changed nothing.
 *
 * ## Paging
 *
 * `limit` is clamped and a malformed value falls back to the default rather than
 * 400ing, matching `routes/messages.ts` next door. Mongo's `.limit(Number(x))`
 * quietly accepted `NaN`; binding one to Postgres is a driver error, so parsing
 * it is not optional any more. No client sends either parameter today
 * (`stores/conversationsStore.ts` GETs the bare path), so the cap cannot reach one.
 */

import { Router, Response } from "express";
import type { AlloAuthRequest as AuthRequest } from "../types/realtime";
import { getRequiredOxyUserId as getAuthenticatedUserId } from "@oxyhq/core/server";
import { sendErrorResponse, sendSuccessResponse, validateRequired } from "../utils/apiHelpers";
import { oxy } from "../../server";
import { logger } from "../utils/logger";
import type {
  ConversationDto,
  ConversationType,
  EnrichedConversationParticipant,
} from "@allo/shared-types";
import { getDb } from "../db";
import {
  addParticipants,
  createConversation,
  findConversationForParticipant,
  findDirectConversationBetween,
  listConversationsForUser,
  markConversationRead,
  removeParticipant,
  setConversationArchived,
  updateConversationDetails,
  type ConversationRecord,
} from "../db/messaging/conversationRepository";
import { toConversationDto, toConversationParticipant } from "../utils/conversationDto";
import {
  enrichParticipantWithOxyUser,
  isOxyUserNotFound,
} from "../utils/oxyUserDisplay";

const router = Router();

const DEFAULT_CONVERSATION_LIMIT = 50;
const MAX_CONVERSATION_LIMIT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A non-negative integer from a query string, or `null` if it is not one. */
function parseCount(value: unknown): number | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseLimit(value: unknown): number {
  const parsed = parseCount(value);
  if (parsed === null || parsed === 0) return DEFAULT_CONVERSATION_LIMIT;
  return Math.min(parsed, MAX_CONVERSATION_LIMIT);
}

/**
 * Enrich conversation participants with Oxy user data (name, username, avatar)
 * This is like WhatsApp - backend processes names using Oxy for efficiency
 */
async function enrichParticipantsWithOxyData(
  participants: Parameters<typeof enrichParticipantWithOxyUser>[0][]
): Promise<EnrichedConversationParticipant[]> {
  const userIds = Array.from(new Set(participants.map(p => p.userId).filter(Boolean)));
  if (userIds.length === 0) return participants;

  // Batch fetch user data from Oxy (efficient like WhatsApp - deduplicated and parallel)
  const userPromises = userIds.map(async (userId) => {
    try {
      const user = await oxy.getUserById(userId);
      return { userId, user };
    } catch (error: unknown) {
      // Handle 404 errors gracefully (user might be deleted) - don't log as error
      if (isOxyUserNotFound(error)) {
        logger.debug(`[Conversations] Oxy user ${userId} not found - using participant data`);
      } else {
        logger.error(`[Conversations] Error fetching Oxy user ${userId}:`, error);
      }
      return { userId, user: null };
    }
  });

  const userResults = await Promise.all(userPromises);
  const userMap = new Map(userResults.map(r => [r.userId, r.user]));

  // Enrich participants with Oxy data
  return participants.map((participant) => {
    return enrichParticipantWithOxyUser(participant, userMap.get(participant.userId));
  });
}

/**
 * A conversation with its participants resolved against Oxy.
 *
 * The two READ routes do this; the write routes deliberately do not, because
 * Mongo returned the saved document unenriched and a client that has just
 * created or patched a conversation already holds the profiles it sent.
 */
async function toEnrichedDto(conversation: ConversationRecord): Promise<ConversationDto> {
  const enriched = await enrichParticipantsWithOxyData(
    conversation.participants.map(toConversationParticipant)
  );
  return toConversationDto(conversation, enriched);
}

/** The same shape without the Oxy round trip. */
function toPlainDto(conversation: ConversationRecord): ConversationDto {
  return toConversationDto(conversation, conversation.participants.map(toConversationParticipant));
}

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

    const conversations = await listConversationsForUser(getDb(), {
      userId,
      limit: parseLimit(req.query.limit),
      offset: parseCount(req.query.offset) ?? 0,
    });

    // Enrich all participants with Oxy user data (like WhatsApp - efficient batch processing)
    const enrichedConversations = await Promise.all(conversations.map(toEnrichedDto));

    return sendSuccessResponse(res, 200, { conversations: enrichedConversations });
  } catch (err) {
    logger.error("[Conversations] Error fetching conversations:", err);
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

    const conversation = await findConversationForParticipant(getDb(), id, userId);

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    return sendSuccessResponse(res, 200, await toEnrichedDto(conversation));
  } catch (err) {
    logger.error("[Conversations] Error fetching conversation:", err);
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
    const body: unknown = req.body;
    const source = isRecord(body) ? body : {};

    const rawType = source.type === undefined ? "direct" : source.type;
    if (rawType !== "direct" && rawType !== "group") {
      return sendErrorResponse(res, 400, "Bad Request", "type must be 'direct' or 'group'");
    }
    const type: ConversationType = rawType;

    const { participantIds } = source;
    if (!Array.isArray(participantIds) || participantIds.length < 1) {
      return sendErrorResponse(res, 400, "Bad Request", "At least one participant is required");
    }

    const parsedParticipantIds: string[] = [];
    for (const participantId of participantIds) {
      const parsed = parseNonEmptyString(participantId);
      if (parsed === null) {
        return sendErrorResponse(res, 400, "Bad Request", "participantIds must be non-empty strings");
      }
      parsedParticipantIds.push(parsed);
    }

    // Ensure current user is included
    const allParticipants = Array.from(new Set([userId, ...parsedParticipantIds]));

    if (type === "direct") {
      const [first, second] = allParticipants;
      if (allParticipants.length !== 2 || first === undefined || second === undefined) {
        return sendErrorResponse(
          res,
          400,
          "Bad Request",
          "Direct conversations must have exactly 2 participants"
        );
      }

      // Check if direct conversation already exists
      const existing = await findDirectConversationBetween(getDb(), [first, second]);
      if (existing) {
        return sendSuccessResponse(res, 200, toPlainDto(existing));
      }
    }

    const conversation = await createConversation(getDb(), {
      type,
      createdBy: userId,
      participants: allParticipants.map((participantId) => ({
        userId: participantId,
        role: participantId === userId ? "admin" : "member",
      })),
      // Group-only presentation fields, exactly as before.
      name: type === "group" ? parseNonEmptyString(source.name) : null,
      description: type === "group" ? parseNonEmptyString(source.description) : null,
      avatar: type === "group" ? parseNonEmptyString(source.avatar) : null,
    });

    return sendSuccessResponse(res, 201, toPlainDto(conversation));
  } catch (err) {
    logger.error("[Conversations] Error creating conversation:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to create conversation");
  }
});

/**
 * PUT /api/conversations/:id
 * Update a conversation (name, description, avatar for groups, theme for all)
 */
router.put("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;
    const body: unknown = req.body;
    const source = isRecord(body) ? body : {};

    const conversation = await findConversationForParticipant(getDb(), id, userId);

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    /**
     * `undefined` means "leave alone" and `null` means "clear" — the
     * distinction Mongoose's assignment threw away, and the reason the patch is
     * built field by field rather than spread from the body.
     */
    const patch: {
      name?: string | null;
      description?: string | null;
      avatar?: string | null;
      theme?: string | null;
    } = {};

    // Theme can be updated for both group and direct conversations
    const themeChanged =
      source.theme !== undefined && conversation.theme !== parseNonEmptyString(source.theme);
    if (source.theme !== undefined) {
      patch.theme = parseNonEmptyString(source.theme);
    }

    // Name, description, and avatar are group-only
    if (conversation.type === "group") {
      if (source.name !== undefined) patch.name = parseNonEmptyString(source.name);
      if (source.description !== undefined) {
        patch.description = parseNonEmptyString(source.description);
      }
      if (source.avatar !== undefined) patch.avatar = parseNonEmptyString(source.avatar);
    }

    const updated = await updateConversationDetails(getDb(), id, patch);

    if (!updated) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    // Emit socket event to all conversation participants when theme changes.
    // The messaging namespace is the one clients connect to (see
    // hooks/useRealtimeMessaging.ts) — emitting on the root Socket.IO server
    // would reach nobody.
    if (themeChanged) {
      const messagingNamespace = req.app.locals.realtime?.messagingNamespace;
      if (messagingNamespace) {
        // Emit to all participants except the user who made the change
        updated.participants.forEach((participant) => {
          if (participant.userId !== userId) {
            messagingNamespace.to(`user:${participant.userId}`).emit("conversationThemeUpdated", {
              conversationId: updated.id,
              theme: updated.theme,
            });
          }
        });
      } else {
        logger.error("[Conversations] Socket.IO unavailable; theme update emit skipped");
      }
    }

    return sendSuccessResponse(res, 200, toPlainDto(updated));
  } catch (err) {
    logger.error("[Conversations] Error updating conversation:", err);
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
    const body: unknown = req.body;
    const source = isRecord(body) ? body : {};

    const { participantIds } = source;
    if (!Array.isArray(participantIds) || participantIds.length === 0) {
      return sendErrorResponse(res, 400, "Bad Request", "At least one participant ID is required");
    }

    const parsedParticipantIds: string[] = [];
    for (const participantId of participantIds) {
      const parsed = parseNonEmptyString(participantId);
      if (parsed === null) {
        return sendErrorResponse(res, 400, "Bad Request", "participantIds must be non-empty strings");
      }
      parsedParticipantIds.push(parsed);
    }

    const conversation = await findConversationForParticipant(getDb(), id, userId);

    if (!conversation || conversation.type !== "group") {
      return sendErrorResponse(res, 404, "Not Found", "Group conversation not found");
    }

    // Already-present ids are refused by the unique index rather than by a
    // comparison that raced, so the whole request is handed over as-is.
    const updated = await addParticipants(
      getDb(),
      id,
      parsedParticipantIds.map((participantId) => ({ userId: participantId, role: "member" }))
    );

    if (!updated) {
      return sendErrorResponse(res, 404, "Not Found", "Group conversation not found");
    }

    return sendSuccessResponse(res, 200, toPlainDto(updated));
  } catch (err) {
    logger.error("[Conversations] Error adding participants:", err);
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

    const conversation = await findConversationForParticipant(getDb(), id, userId);

    if (!conversation || conversation.type !== "group") {
      return sendErrorResponse(res, 404, "Not Found", "Group conversation not found");
    }

    if (participantId === userId) {
      return sendErrorResponse(res, 400, "Bad Request", "Cannot remove yourself. Use leave endpoint instead.");
    }

    const outcome = await removeParticipant(getDb(), id, participantId);

    if (outcome.outcome === "would_leave_too_few") {
      return sendErrorResponse(
        res,
        400,
        "Bad Request",
        "Cannot remove participant. Group must have at least 2 members."
      );
    }

    // `not_a_participant` is a 200 with the unchanged conversation, which is
    // what Mongo did: filtering an absent id left the array alone and saved.
    const updated = await findConversationForParticipant(getDb(), id, userId);

    if (!updated) {
      return sendErrorResponse(res, 404, "Not Found", "Group conversation not found");
    }

    return sendSuccessResponse(res, 200, toPlainDto(updated));
  } catch (err) {
    logger.error("[Conversations] Error removing participant:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to remove participant");
  }
});

/**
 * POST /api/conversations/:id/archive
 * Archive a conversation
 */
router.post("/:id/archive", async (req: AuthRequest, res: Response) => {
  return setArchived(req, res, true, "archive");
});

/**
 * POST /api/conversations/:id/unarchive
 * Unarchive a conversation
 */
router.post("/:id/unarchive", async (req: AuthRequest, res: Response) => {
  return setArchived(req, res, false, "unarchive");
});

/**
 * Both archive routes, which differ only in the flag and the word in the
 * messages.
 *
 * Archival is now one participant's `archived_at`, so the write is the same
 * statement either way — and `archived` being the only real difference is what
 * makes "archive" and "unarchive" incapable of drifting apart.
 */
async function setArchived(
  req: AuthRequest,
  res: Response,
  archived: boolean,
  verb: "archive" | "unarchive"
): Promise<Response> {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const isParticipant = await setConversationArchived(getDb(), id, userId, archived);

    if (!isParticipant) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    // Re-read so the response is the conversation, as it was before. The
    // archived row is still found here: only the LIST filters on `archived_at`.
    const conversation = await findConversationForParticipant(getDb(), id, userId);

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    return sendSuccessResponse(res, 200, toPlainDto(conversation));
  } catch (err) {
    logger.error(`[Conversations] Error running ${verb} on conversation:`, err);
    return sendErrorResponse(res, 500, "Internal Server Error", `Failed to ${verb} conversation`);
  }
}

/**
 * POST /api/conversations/:id/mark-read
 * Mark conversation as read
 */
router.post("/:id/mark-read", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    // `lastReadAt` and the unread count live on the same row now, so the two
    // halves Mongo wrote in separate places cannot disagree.
    const isParticipant = await markConversationRead(getDb(), id, userId);

    if (!isParticipant) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    const conversation = await findConversationForParticipant(getDb(), id, userId);

    if (!conversation) {
      return sendErrorResponse(res, 404, "Not Found", "Conversation not found");
    }

    return sendSuccessResponse(res, 200, toPlainDto(conversation));
  } catch (err) {
    logger.error("[Conversations] Error marking conversation as read:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to mark conversation as read");
  }
});

export default router;
