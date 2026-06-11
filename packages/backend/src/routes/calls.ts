import { Router, Response } from "express";
import Call from "../models/Call";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import { sendErrorResponse, sendSuccessResponse } from "../utils/apiHelpers";
import { oxy } from "../../server";
import { logger } from "../utils/logger";

const router = Router();

interface OxyUserSummary {
  id: string;
  name?: { first?: string; last?: string } | string;
  username?: string;
  handle?: string;
  avatar?: string;
}

/**
 * Batch-fetch peer profiles from Oxy and return a Map<userId, summary>.
 * Mirrors the enrichment pattern used in conversations.ts.
 */
async function fetchPeerSummaries(userIds: string[]): Promise<Map<string, OxyUserSummary>> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  const result = new Map<string, OxyUserSummary>();
  if (unique.length === 0) return result;

  const lookups = await Promise.all(
    unique.map(async (uid) => {
      try {
        const user: any = await oxy.getUserById(uid);
        return { uid, user };
      } catch (err: any) {
        if (err?.status !== 404) {
          logger.warn(`[Calls] Failed to fetch Oxy user ${uid}`, err?.message || err);
        }
        return { uid, user: null };
      }
    })
  );

  for (const { uid, user } of lookups) {
    if (!user) continue;
    result.set(uid, {
      id: uid,
      name: user.name,
      username: user.username,
      handle: user.handle,
      avatar: user.avatar?.url || user.avatar || undefined,
    });
  }
  return result;
}

/**
 * Calls API
 * All routes require authentication.
 */

/**
 * GET /api/calls
 * Call history for the authenticated user (as caller or callee), newest first.
 * Query: ?limit=50&offset=0
 */
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const limit = Math.min(Math.max(parseInt((req.query.limit as string) || "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt((req.query.offset as string) || "0", 10) || 0, 0);

    const filter = {
      $or: [{ callerId: userId }, { calleeId: userId }],
    };

    const [calls, total] = await Promise.all([
      Call.find(filter).sort({ startedAt: -1 }).skip(offset).limit(limit).lean(),
      Call.countDocuments(filter),
    ]);

    const peerIds = calls.map((c) => (c.callerId === userId ? c.calleeId : c.callerId));
    const summaries = await fetchPeerSummaries(peerIds);

    const enriched = calls.map((c) => {
      const peerId = c.callerId === userId ? c.calleeId : c.callerId;
      const direction: "incoming" | "outgoing" = c.callerId === userId ? "outgoing" : "incoming";
      return {
        id: String(c._id),
        callerId: c.callerId,
        calleeId: c.calleeId,
        conversationId: c.conversationId,
        type: c.type,
        status: c.status,
        startedAt: c.startedAt,
        connectedAt: c.connectedAt,
        endedAt: c.endedAt,
        durationSec: c.durationSec,
        endedBy: c.endedBy,
        direction,
        peer: summaries.get(peerId) || { id: peerId },
      };
    });

    return sendSuccessResponse(res, 200, {
      calls: enriched,
      total,
      limit,
      offset,
    });
  } catch (err) {
    logger.error("[Calls] Error fetching call history", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch call history");
  }
});

/**
 * GET /api/calls/:id
 * Detail for a single call (must be a participant).
 */
router.get("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;
    const call = await Call.findById(id).lean();
    if (!call) {
      return sendErrorResponse(res, 404, "Not Found", "Call not found");
    }
    if (call.callerId !== userId && call.calleeId !== userId) {
      return sendErrorResponse(res, 403, "Forbidden", "Access denied");
    }
    const peerId = call.callerId === userId ? call.calleeId : call.callerId;
    const summaries = await fetchPeerSummaries([peerId]);
    return sendSuccessResponse(res, 200, {
      id: String(call._id),
      callerId: call.callerId,
      calleeId: call.calleeId,
      conversationId: call.conversationId,
      type: call.type,
      status: call.status,
      startedAt: call.startedAt,
      connectedAt: call.connectedAt,
      endedAt: call.endedAt,
      durationSec: call.durationSec,
      endedBy: call.endedBy,
      direction: call.callerId === userId ? "outgoing" : "incoming",
      peer: summaries.get(peerId) || { id: peerId },
    });
  } catch (err) {
    logger.error("[Calls] Error fetching call", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch call");
  }
});

/**
 * DELETE /api/calls/:id
 * Remove a call entry from the user's history. Participants only.
 *
 * Real WhatsApp-style behavior would soft-delete per participant; for simplicity
 * (and because the entry has no further side effects) we hard-delete the
 * document once any participant requests removal. This matches the spec's
 * "delete entry from history" semantics for 1:1 calls.
 */
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;
    const call = await Call.findById(id);
    if (!call) {
      return sendErrorResponse(res, 404, "Not Found", "Call not found");
    }
    if (call.callerId !== userId && call.calleeId !== userId) {
      return sendErrorResponse(res, 403, "Forbidden", "Access denied");
    }
    await Call.deleteOne({ _id: id });
    return sendSuccessResponse(res, 200, { id, deleted: true });
  } catch (err) {
    logger.error("[Calls] Error deleting call", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to delete call");
  }
});

export default router;
