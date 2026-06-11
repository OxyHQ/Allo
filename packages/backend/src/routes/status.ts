import { Router, Response } from "express";
import Status, {
  IStatusAudience,
  StatusAudienceType,
  StatusType,
} from "../models/Status";
import Conversation from "../models/Conversation";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import {
  sendErrorResponse,
  sendSuccessResponse,
  validateRequired,
} from "../utils/apiHelpers";
import { computeAudience } from "../utils/presence";
import { logger } from "../utils/logger";
import { oxy } from "../../server";

const router = Router();

const STATUS_TYPES: StatusType[] = ["image", "video", "text"];
const AUDIENCE_TYPES: StatusAudienceType[] = ["all-contacts", "except", "only"];

const MAX_TEXT_LENGTH = 700;
const MAX_CAPTION_LENGTH = 500;
const MAX_AUDIENCE_USER_IDS = 1024;

/**
 * A "contact" in Allo is a user with whom you share at least one conversation
 * (direct or group) — exactly the audience presence fans out to. Status
 * visibility is scoped to this set so a status is NEVER world-readable: even an
 * `all-contacts` status is only ever shown to people the author actually talks
 * to. This mirrors `resolvePresenceAudienceAndEmit` in `server.ts`.
 */
const MAX_STATUS_CONTACTS = 500;

async function resolveContactIds(userId: string): Promise<string[]> {
  const conversations = await Conversation.find(
    { "participants.userId": userId },
    { "participants.userId": 1 }
  )
    .limit(MAX_STATUS_CONTACTS)
    .lean();
  return computeAudience(conversations, userId, MAX_STATUS_CONTACTS);
}

/**
 * Resolve the set of user ids a status event (created/deleted) should fan out
 * to, given the author and the status's audience. Always includes the author
 * (own multi-device sync) plus the contacts permitted by the audience rule:
 *
 *   all-contacts → every contact
 *   except       → every contact NOT in `userIds`
 *   only         → only contacts that are also in `userIds`
 *
 * Intersecting with the contact set means a status never notifies a stranger,
 * and an `only` allowlist entry who isn't a contact is silently ignored.
 */
async function resolveStatusRecipients(
  authorId: string,
  audience: IStatusAudience
): Promise<string[]> {
  const contactIds = await resolveContactIds(authorId);
  let recipients: string[];
  switch (audience.type) {
    case "except": {
      const excluded = new Set(audience.userIds);
      recipients = contactIds.filter((id) => !excluded.has(id));
      break;
    }
    case "only": {
      const allowed = new Set(audience.userIds);
      recipients = contactIds.filter((id) => allowed.has(id));
      break;
    }
    default:
      recipients = contactIds;
      break;
  }
  return [authorId, ...recipients];
}

/**
 * Returns a Mongoose `$or` clause matching the privacy rules for the given
 * viewer:
 *
 *   audience.type === 'all-contacts'   → always allowed
 *   audience.type === 'except'         → allowed if viewer is NOT in userIds
 *   audience.type === 'only'           → allowed if viewer IS in userIds
 *
 * The author of a status can always see it (handled separately by the caller).
 */
function audienceFilterForViewer(viewerId: string) {
  return {
    $or: [
      { "audience.type": "all-contacts" },
      { "audience.type": "except", "audience.userIds": { $ne: viewerId } },
      { "audience.type": "only", "audience.userIds": viewerId },
    ],
  };
}

interface AudienceInput {
  type?: unknown;
  userIds?: unknown;
}

function normalizeAudience(input?: AudienceInput): IStatusAudience {
  if (!input || typeof input !== "object") {
    return { type: "all-contacts", userIds: [] };
  }
  const type: StatusAudienceType = AUDIENCE_TYPES.includes(input.type as StatusAudienceType)
    ? (input.type as StatusAudienceType)
    : "all-contacts";

  let userIds: string[] = [];
  if (Array.isArray(input.userIds)) {
    userIds = (input.userIds as unknown[])
      .filter((u): u is string => typeof u === "string" && u.trim().length > 0)
      .slice(0, MAX_AUDIENCE_USER_IDS);
    // Dedup
    userIds = Array.from(new Set(userIds));
  }

  if (type === "all-contacts") {
    userIds = [];
  }

  return { type, userIds };
}

/** A stored viewer entry as it appears on a hydrated or lean Status document. */
interface RawViewer {
  userId: string;
  viewedAt: Date | string;
}

/**
 * The fields `statusToJSON` reads. A `Status.find(...).lean()` result and a
 * hydrated Status document both satisfy this (the latter via its `toObject()`
 * output), so we can serialize either without `any`.
 */
interface StatusSource {
  _id?: unknown;
  id?: unknown;
  userId: string;
  type: StatusType;
  mediaUrl?: string;
  mediaThumbnailUrl?: string;
  text?: string;
  caption?: string;
  backgroundColor?: string;
  fontFamily?: string;
  audience?: { type?: StatusAudienceType; userIds?: string[] };
  viewers?: RawViewer[];
  createdAt: Date | string;
  expiresAt: Date | string;
  toObject?: () => StatusSource;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function statusToJSON(doc: StatusSource, viewerId?: string) {
  const obj = typeof doc.toObject === "function" ? doc.toObject() : doc;
  const viewers = (obj.viewers || []).map((v) => ({
    userId: v.userId,
    viewedAt: toIso(v.viewedAt),
  }));

  return {
    id: String(obj._id || obj.id),
    userId: obj.userId,
    type: obj.type,
    mediaUrl: obj.mediaUrl,
    mediaThumbnailUrl: obj.mediaThumbnailUrl,
    text: obj.text,
    caption: obj.caption,
    backgroundColor: obj.backgroundColor,
    fontFamily: obj.fontFamily,
    audience: {
      type: obj.audience?.type || "all-contacts",
      userIds: Array.isArray(obj.audience?.userIds) ? obj.audience.userIds : [],
    },
    viewers,
    viewedByMe: viewerId
      ? viewers.some((v) => v.userId === viewerId)
      : undefined,
    createdAt: toIso(obj.createdAt),
    expiresAt: toIso(obj.expiresAt),
  };
}

interface OxyUserMinimal {
  id?: string;
  username?: string;
  handle?: string;
  avatar?: string;
  name?: string | { first?: string; last?: string };
}

/** The subset of the Oxy user record we read (the SDK types it more broadly). */
interface OxyUserRecord {
  username?: string;
  handle?: string;
  avatar?: string;
  name?: string | { first?: string; last?: string } | null;
}

/** Narrow accessor over the Oxy client so we never reach for `as any`. */
interface OxyUserFetcher {
  getUserById(id: string): Promise<OxyUserRecord | null>;
}
const userFetcher: OxyUserFetcher = oxy;

/** HTTP-ish error shape the Oxy client throws (status / code carriers). */
function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: number; code?: string };
  return e.status === 404 || e.code === "ERR_BAD_REQUEST";
}

function normalizeName(
  name: OxyUserRecord["name"]
): string | { first: string; last: string } | undefined {
  if (typeof name === "string") return name;
  if (name && typeof name === "object") {
    return { first: name.first || "", last: name.last || "" };
  }
  return undefined;
}

async function fetchAuthors(userIds: string[]): Promise<Map<string, OxyUserMinimal>> {
  const unique = Array.from(new Set(userIds.filter(Boolean)));
  const results = await Promise.all(
    unique.map(async (id) => {
      try {
        const user = await userFetcher.getUserById(id);
        return [id, user] as const;
      } catch (error) {
        if (isNotFoundError(error)) {
          // Author may have been deleted — degrade gracefully.
          return [id, null] as const;
        }
        logger.error(`Error fetching Oxy user ${id}`, error);
        return [id, null] as const;
      }
    })
  );

  const map = new Map<string, OxyUserMinimal>();
  for (const [id, user] of results) {
    if (user) {
      map.set(id, {
        id,
        username: user.username || user.handle,
        avatar: user.avatar,
        name: normalizeName(user.name),
      });
    }
  }
  return map;
}

function emitStatusEvent(
  event: "statusCreated" | "statusViewed" | "statusDeleted",
  payload: Record<string, unknown>,
  recipientUserIds: string[]
): void {
  const io = global.io;
  if (!io) return;
  const messagingNamespace = io.of("/messaging");
  const targets = Array.from(new Set(recipientUserIds.filter(Boolean)));
  for (const userId of targets) {
    messagingNamespace.to(`user:${userId}`).emit(event, payload);
  }
}

/**
 * GET /api/status
 *
 * Returns:
 *   - `groups`:    statuses authored by *other* users that the viewer is
 *                  permitted to see (per audience rules), grouped by author,
 *                  newest group first; each group's statuses are in
 *                  chronological order with `viewedByMe` flag.
 *   - `myStatus`:  the viewer's own non-expired statuses.
 */
router.get("/", async (req: AuthRequest, res: Response) => {
  try {
    const viewerId = getAuthenticatedUserId(req);
    const now = new Date();

    // Scope "others" strictly to the viewer's conversation-sharing contacts so
    // statuses are never world-readable. With no contacts there is nothing to
    // fetch — short-circuit the (potentially large) collection scan.
    const contactIds = await resolveContactIds(viewerId);

    const [othersDocs, mineDocs] = await Promise.all([
      contactIds.length === 0
        ? Promise.resolve<StatusSource[]>([])
        : Status.find({
            userId: { $in: contactIds },
            expiresAt: { $gt: now },
            ...audienceFilterForViewer(viewerId),
          })
            .sort({ createdAt: 1 })
            .lean<StatusSource[]>(),
      Status.find({
        userId: viewerId,
        expiresAt: { $gt: now },
      })
        .sort({ createdAt: 1 })
        .lean<StatusSource[]>(),
    ]);

    // Enrich authors of "others" groups.
    const authorIds = Array.from(new Set(othersDocs.map((d) => d.userId)));
    const authorMap = await fetchAuthors(authorIds);

    // Group by userId, preserving chronological order.
    const groupsMap = new Map<
      string,
      { userId: string; statuses: ReturnType<typeof statusToJSON>[]; lastCreatedAt: string }
    >();

    for (const doc of othersDocs) {
      const json = statusToJSON(doc, viewerId);
      const existing = groupsMap.get(json.userId);
      if (existing) {
        existing.statuses.push(json);
        if (json.createdAt > existing.lastCreatedAt) {
          existing.lastCreatedAt = json.createdAt;
        }
      } else {
        groupsMap.set(json.userId, {
          userId: json.userId,
          statuses: [json],
          lastCreatedAt: json.createdAt,
        });
      }
    }

    const groups = Array.from(groupsMap.values())
      .map((g) => ({
        userId: g.userId,
        author: authorMap.get(g.userId),
        statuses: g.statuses,
        lastCreatedAt: g.lastCreatedAt,
        hasUnviewed: g.statuses.some((s) => !s.viewedByMe),
      }))
      // Newest group first.
      .sort((a, b) => (a.lastCreatedAt < b.lastCreatedAt ? 1 : -1));

    const myStatus = mineDocs.map((d) => statusToJSON(d, viewerId));

    return sendSuccessResponse(res, 200, { groups, myStatus });
  } catch (err) {
    logger.error("Error fetching status feed", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch status feed");
  }
});

/**
 * GET /api/status/me
 * Returns the authenticated user's non-expired statuses including viewers.
 */
router.get("/me", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const docs = await Status.find({
      userId,
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .lean<StatusSource[]>();

    return sendSuccessResponse(res, 200, {
      statuses: docs.map((d) => statusToJSON(d, userId)),
    });
  } catch (err) {
    logger.error("Error fetching my statuses", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch my statuses");
  }
});

/**
 * POST /api/status
 * Body: { type, mediaUrl?, mediaThumbnailUrl?, text?, caption?,
 *         backgroundColor?, fontFamily?, audience? }
 */
router.post("/", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const {
      type,
      mediaUrl,
      mediaThumbnailUrl,
      text,
      caption,
      backgroundColor,
      fontFamily,
      audience,
    } = req.body || {};

    const validationError = validateRequired(type, "type");
    if (validationError) {
      return sendErrorResponse(res, 400, "Bad Request", validationError);
    }

    if (!STATUS_TYPES.includes(type)) {
      return sendErrorResponse(
        res,
        400,
        "Bad Request",
        `\`type\` must be one of ${STATUS_TYPES.join(", ")}`
      );
    }

    const trimmedText = typeof text === "string" ? text.trim() : undefined;
    const trimmedCaption = typeof caption === "string" ? caption.trim() : undefined;

    if (type === "text") {
      if (!trimmedText) {
        return sendErrorResponse(res, 400, "Bad Request", "Text statuses require `text`");
      }
      if (trimmedText.length > MAX_TEXT_LENGTH) {
        return sendErrorResponse(
          res,
          400,
          "Bad Request",
          `Text exceeds maximum length of ${MAX_TEXT_LENGTH}`
        );
      }
    } else {
      if (!mediaUrl || typeof mediaUrl !== "string") {
        return sendErrorResponse(
          res,
          400,
          "Bad Request",
          `${type} statuses require a \`mediaUrl\``
        );
      }
      if (trimmedCaption && trimmedCaption.length > MAX_CAPTION_LENGTH) {
        return sendErrorResponse(
          res,
          400,
          "Bad Request",
          `Caption exceeds maximum length of ${MAX_CAPTION_LENGTH}`
        );
      }
    }

    const status = await Status.create({
      userId,
      type,
      mediaUrl: type === "text" ? undefined : mediaUrl,
      mediaThumbnailUrl: type === "text" ? undefined : mediaThumbnailUrl,
      text: type === "text" ? trimmedText : undefined,
      caption: type === "text" ? undefined : trimmedCaption,
      backgroundColor: typeof backgroundColor === "string" ? backgroundColor : undefined,
      fontFamily: typeof fontFamily === "string" ? fontFamily : undefined,
      audience: normalizeAudience(audience),
    });

    // Real-time fan-out, audience-scoped (never broadcast). Always include the
    // author's own room for multi-device sync, then add the recipients allowed
    // by the per-status audience, intersected with the author's contacts so we
    // never notify a stranger.
    const authorMap = await fetchAuthors([userId]);
    const author = authorMap.get(userId);
    const payload = {
      status: statusToJSON(status, userId),
      author,
    };

    const recipients = await resolveStatusRecipients(userId, status.audience);
    emitStatusEvent("statusCreated", payload, recipients);

    return sendSuccessResponse(res, 201, statusToJSON(status, userId));
  } catch (err) {
    logger.error("Error creating status", err);
    const message = err instanceof Error ? err.message : "Failed to create status";
    if (
      message.includes("require") ||
      message.includes("invalid") ||
      message.includes("Invalid")
    ) {
      return sendErrorResponse(res, 400, "Bad Request", message);
    }
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to create status");
  }
});

/**
 * POST /api/status/:id/view
 * Idempotently records that the viewer has seen this status.
 */
router.post("/:id/view", async (req: AuthRequest, res: Response) => {
  try {
    const viewerId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const status = await Status.findById(id);
    if (!status || status.expiresAt <= new Date()) {
      return sendErrorResponse(res, 404, "Not Found", "Status not found");
    }

    // Viewers can't "view" their own statuses (no-op, but still return success
    // so the client can treat the call uniformly).
    if (status.userId === viewerId) {
      return sendSuccessResponse(res, 200, statusToJSON(status, viewerId));
    }

    // Audience enforcement. The viewer must (a) be a contact of the author —
    // share a conversation — and (b) satisfy the status's per-status audience
    // rule. Both checks together guarantee a status is never viewable by a
    // stranger who somehow learns its id.
    const contactIds = await resolveContactIds(viewerId);
    const isContact = contactIds.includes(status.userId);

    const audience = status.audience;
    const passesAudience =
      audience.type === "all-contacts" ||
      (audience.type === "except" && !audience.userIds.includes(viewerId)) ||
      (audience.type === "only" && audience.userIds.includes(viewerId));

    if (!isContact || !passesAudience) {
      return sendErrorResponse(res, 403, "Forbidden", "Not allowed to view this status");
    }

    // Atomic, race-safe view recording: a single conditional `$push` that only
    // matches when this viewer is NOT already in `viewers`. Two concurrent views
    // can't both match, so we never get duplicate viewer entries or duplicate
    // `statusViewed` emits — `modifiedCount === 1` identifies the single writer.
    const viewedAt = new Date();
    const result = await Status.updateOne(
      {
        _id: id,
        expiresAt: { $gt: new Date() },
        "viewers.userId": { $ne: viewerId },
      },
      { $push: { viewers: { userId: viewerId, viewedAt } } }
    );

    if (result.modifiedCount === 1) {
      // Reflect the just-added viewer in the in-memory doc for the response,
      // then notify the author (exactly once, by the single winning writer).
      status.viewers.push({ userId: viewerId, viewedAt });
      emitStatusEvent(
        "statusViewed",
        {
          statusId: String(status._id),
          ownerId: status.userId,
          viewerId,
          viewedAt: viewedAt.toISOString(),
        },
        [status.userId]
      );
    }

    return sendSuccessResponse(res, 200, statusToJSON(status, viewerId));
  } catch (err) {
    logger.error("Error marking status viewed", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to mark status viewed");
  }
});

/**
 * GET /api/status/:id/viewers
 * Owner-only. Returns the list of viewers ordered by `viewedAt` desc.
 */
router.get("/:id/viewers", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const status = await Status.findById(id).lean<StatusSource>();
    if (!status) {
      return sendErrorResponse(res, 404, "Not Found", "Status not found");
    }
    if (status.userId !== userId) {
      return sendErrorResponse(res, 403, "Forbidden", "Only the author can see viewers");
    }

    const viewers = (status.viewers || [])
      .map((v) => ({
        userId: v.userId,
        viewedAt: toIso(v.viewedAt),
      }))
      .sort((a, b) => (a.viewedAt < b.viewedAt ? 1 : -1));

    const authorMap = await fetchAuthors(viewers.map((v) => v.userId));
    const enriched = viewers.map((v) => ({
      ...v,
      user: authorMap.get(v.userId),
    }));

    return sendSuccessResponse(res, 200, { viewers: enriched });
  } catch (err) {
    logger.error("Error fetching status viewers", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch viewers");
  }
});

/**
 * DELETE /api/status/:id
 * Only the author may delete their status.
 */
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;

    const status = await Status.findById(id);
    if (!status) {
      return sendErrorResponse(res, 404, "Not Found", "Status not found");
    }
    if (status.userId !== userId) {
      return sendErrorResponse(res, 403, "Forbidden", "Only the author can delete this status");
    }

    const recipients = await resolveStatusRecipients(userId, status.audience);

    await status.deleteOne();

    emitStatusEvent(
      "statusDeleted",
      { statusId: String(status._id), ownerId: userId },
      recipients
    );

    return sendSuccessResponse(res, 200, { id: String(status._id), deleted: true });
  } catch (err) {
    logger.error("Error deleting status", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to delete status");
  }
});

export default router;
