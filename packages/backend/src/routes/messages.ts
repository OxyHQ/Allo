import { Router, Response } from "express";
import path from "path";
import fs from "fs";
import multer from "multer";
import type { Namespace } from "socket.io";
import Message, { type PollData } from "../models/Message";
import Conversation from "../models/Conversation";
import Device from "../models/Device";
import MessageEnvelope from "../models/MessageEnvelope";
import { AuthRequest } from "../middleware/auth";
import { getAuthenticatedUserId } from "../utils/auth";
import { sendErrorResponse, sendSuccessResponse, validateRequired } from "../utils/apiHelpers";
import { validateEncryptedMessage, validateEnvelopeMessage } from "../utils/signalProtocol";
import {
  ENCRYPTION_VERSION_ENVELOPES,
  type DeviceTarget,
  type MessageEnvelopeDTO,
} from "@allo/shared-types";
import {
  DEVICE_INACTIVE_DAYS,
  ENVELOPE_DELIVERED_RETENTION_DAYS,
  ENVELOPE_RETENTION_DAYS,
  daysAgo,
  daysFromNow,
  isActiveDevice,
} from "../config/multiDevice";
import {
  UPLOAD_DIR,
  UPLOAD_MAX_FILE_SIZE,
  DANGEROUS_EXTENSIONS,
  buildSafeStoredFilename,
  isAllowedMime,
} from "../config/uploads";
import { isBridgeEnabled } from "../config/bridge";
import * as BridgeService from "../services/BridgeService";

const router = Router();

/**
 * Resolve the Socket.IO `/messaging` namespace, or null when sockets aren't
 * wired (e.g. unit tests). Centralized so every route resolves it the same way.
 */
function getMessagingNamespace(): Namespace | null {
  const io = (global as { io?: { of: (nsp: string) => Namespace } }).io;
  return io ? io.of("/messaging") : null;
}

/** Build the per-device room name used to address a single device. */
function deviceRoom(userId: string, deviceId: number): string {
  return `device:${userId}:${deviceId}`;
}

/** Read and validate the numeric `X-Device-Id` request header, if present. */
function getRequestDeviceId(req: AuthRequest): number | null {
  const raw = req.header("X-Device-Id");
  if (raw === undefined || raw === null || raw === "") return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : null;
}

interface LeanEnvelopeForHydration {
  messageId: string;
  recipientDeviceId: number;
  ciphertext: string;
  mediaKeys?: Array<{ mediaId: string; wrappedKey: string }>;
}

/**
 * Hydrate a page of lean message objects with per-device ciphertext for v3
 * (envelope) messages. v1/v2 messages are returned untouched. Each v3 message
 * gets `ciphertext` set from the requesting device's envelope (or null) and an
 * `envelopeMissing` flag. Without a device id, every v3 message is masked.
 */
async function hydrateEnvelopes<
  T extends {
    _id: unknown;
    encryptionVersion?: number;
    ciphertext?: string | null;
    mediaKeys?: Array<{ mediaId: string; wrappedKey: string }>;
    envelopeMissing?: boolean;
  }
>(messages: T[], userId: string, deviceId: number | null): Promise<T[]> {
  const v3Messages = messages.filter(
    (m) => m.encryptionVersion === ENCRYPTION_VERSION_ENVELOPES
  );
  if (v3Messages.length === 0) return messages;

  // Without a device id we cannot pick an envelope: mask all v3 ciphertext.
  if (deviceId === null) {
    for (const m of v3Messages) {
      m.ciphertext = null;
      m.envelopeMissing = true;
    }
    return messages;
  }

  const pageIds = v3Messages.map((m) => String(m._id));
  const envelopes = (await MessageEnvelope.find(
    {
      messageId: { $in: pageIds },
      recipientUserId: userId,
      recipientDeviceId: deviceId,
    },
    { messageId: 1, recipientDeviceId: 1, ciphertext: 1, mediaKeys: 1 }
  ).lean()) as unknown as LeanEnvelopeForHydration[];

  const byMessageId = new Map<string, LeanEnvelopeForHydration>();
  for (const env of envelopes) {
    byMessageId.set(String(env.messageId), env);
  }

  for (const m of v3Messages) {
    const env = byMessageId.get(String(m._id));
    if (env) {
      m.ciphertext = env.ciphertext;
      if (env.mediaKeys && env.mediaKeys.length > 0) {
        m.mediaKeys = env.mediaKeys;
      }
      m.envelopeMissing = false;
    } else {
      m.ciphertext = null;
      m.envelopeMissing = true;
    }
  }

  return messages;
}

// --- Upload handling (local disk under packages/backend/uploads) ---
// Files are also (preferably) uploaded via @oxyhq/services from the frontend,
// but this endpoint provides a fallback when Oxy services aren't reachable.
//
// Security: only allowlisted MIME types are accepted, the stored extension is
// re-derived from the validated MIME (never the client filename), and dangerous
// extensions are rejected outright. The static serving layer (server.ts) also
// forces download + nosniff + a sandboxed CSP so nothing executes same-origin.
try {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
} catch (err) {
  console.error("[Messages] Failed to create uploads directory:", err);
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
      // Stored name uses an extension derived from the validated MIME, not the
      // client-supplied filename (which could carry a dangerous extension).
      cb(null, buildSafeStoredFilename(file.originalname, file.mimetype));
    },
  }),
  limits: { fileSize: UPLOAD_MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (DANGEROUS_EXTENSIONS.has(ext)) {
      cb(new Error("File type not allowed"));
      return;
    }
    if (!isAllowedMime(file.mimetype)) {
      cb(new Error("File type not allowed"));
      return;
    }
    cb(null, true);
  },
});

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
      // Exclude messages hidden by the current user ("delete for me")
      hiddenFor: { $ne: userId },
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

    // For v3 (per-device envelope) messages, swap in this device's ciphertext.
    // v1/v2 messages are returned untouched. Client decrypts.
    const deviceId = getRequestDeviceId(req);
    const hydrated = await hydrateEnvelopes(messages, userId, deviceId);

    return sendSuccessResponse(res, 200, { messages: hydrated });
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

    // Hydrate v3 messages with this device's envelope ciphertext.
    const deviceId = getRequestDeviceId(req);
    const [hydrated] = await hydrateEnvelopes([message], userId, deviceId);

    return sendSuccessResponse(res, 200, hydrated);
  } catch (err) {
    console.error("[Messages] Error fetching message:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to fetch message");
  }
});

/** Lightweight shape of a Device document used by the consistency check. */
interface LeanActiveDevice {
  userId: string;
  deviceId: number;
  lastSeen?: Date;
  createdAt?: Date;
}

/**
 * Handle a v3 (per-device envelope) message send. Validates envelopes, enforces
 * device-list consistency, persists the message + envelopes, and fans out
 * device-addressed real-time delivery. The backend never sees plaintext.
 */
async function handleEnvelopeMessage(
  res: Response,
  userId: string,
  conversation: import("../models/Conversation").IConversation,
  body: {
    conversationId: string;
    senderDeviceId: number;
    envelopes: unknown;
    messageType?: string;
    replyTo?: string;
    fontSize?: number;
    forwardedFrom?: string;
    attachmentType?: string;
    encryptedMedia?: unknown;
  }
): Promise<Response> {
  const { conversationId, senderDeviceId } = body;

  // Structural validation of the envelope payload (no decryption).
  if (
    !validateEnvelopeMessage({
      envelopes: body.envelopes as MessageEnvelopeDTO[] | undefined,
      messageType: body.messageType,
    })
  ) {
    return sendErrorResponse(res, 400, "Bad Request", "Malformed envelope message payload");
  }
  const envelopes = body.envelopes as MessageEnvelopeDTO[];

  const participantIds = conversation.participants.map((p) => p.userId);
  const participantSet = new Set(participantIds);

  // Every envelope recipient must be a conversation participant. Sender's own
  // devices are expected (they are a participant), but every recipientUserId
  // must still be in the conversation. The sender's CURRENT device authored the
  // message and must never be an envelope target (it can already read it).
  for (const env of envelopes) {
    if (!participantSet.has(env.recipientUserId)) {
      return sendErrorResponse(
        res,
        400,
        "Bad Request",
        "Envelope recipient is not a conversation participant"
      );
    }
    if (env.recipientUserId === userId && env.recipientDeviceId === senderDeviceId) {
      return res.status(400).json({
        error: "invalid_v3_payload",
        message: "envelope must not target the sender's own current device",
      });
    }
  }

  // Index provided envelopes by target for the consistency check.
  const providedTargets = new Set<string>();
  for (const env of envelopes) {
    providedTargets.add(`${env.recipientUserId}:${env.recipientDeviceId}`);
  }

  // Device-list consistency check: load every participant device in one query.
  const inactiveCutoff = daysAgo(DEVICE_INACTIVE_DAYS);
  const devices = (await Device.find(
    { userId: { $in: participantIds } },
    { userId: 1, deviceId: 1, lastSeen: 1, createdAt: 1 }
  ).lean()) as unknown as LeanActiveDevice[];

  const registeredTargets = new Set<string>();
  const missingDevices: DeviceTarget[] = [];
  for (const device of devices) {
    registeredTargets.add(`${device.userId}:${device.deviceId}`);
    if (!isActiveDevice(device, inactiveCutoff)) continue;
    // The sender's CURRENT device authored the message and is not a recipient.
    if (device.userId === userId && device.deviceId === senderDeviceId) continue;
    const key = `${device.userId}:${device.deviceId}`;
    if (!providedTargets.has(key)) {
      missingDevices.push({ userId: device.userId, deviceId: device.deviceId });
    }
  }

  // Unknown devices = envelope targets that are not registered devices. The
  // sender's own current device is allowed even if (re)registration is in
  // flight; everything else must correspond to a real device.
  const unknownDevices: DeviceTarget[] = [];
  for (const env of envelopes) {
    const key = `${env.recipientUserId}:${env.recipientDeviceId}`;
    if (registeredTargets.has(key)) continue;
    if (env.recipientUserId === userId && env.recipientDeviceId === senderDeviceId) continue;
    unknownDevices.push({
      userId: env.recipientUserId,
      deviceId: env.recipientDeviceId,
    });
  }

  if (missingDevices.length > 0 || unknownDevices.length > 0) {
    return res.status(409).json({
      error: "stale_device_list",
      missingDevices,
      unknownDevices,
    });
  }

  // Resolve message type for envelope messages (encrypted payload only).
  const resolvedType =
    body.messageType ||
    (body.attachmentType === "location"
      ? "location"
      : body.attachmentType === "contact"
        ? "contact"
        : body.attachmentType === "poll"
          ? "poll"
          : body.attachmentType === "file"
            ? "file"
            : body.attachmentType === "audio"
              ? "audio"
              : body.encryptedMedia
                ? "media"
                : "text");

  // Persist the message metadata (no top-level ciphertext for v3).
  const message = await Message.create({
    conversationId,
    senderId: userId,
    senderDeviceId,
    encryptionVersion: ENCRYPTION_VERSION_ENVELOPES,
    envelopeCount: envelopes.length,
    messageType: resolvedType,
    attachmentType: body.attachmentType,
    forwardedFrom: body.forwardedFrom,
    replyTo: body.replyTo,
    fontSize: body.fontSize,
    deliveredTo: [userId], // Sender has received their own message
  });

  // Persist one envelope per recipient device. ordered:false so a single dup
  // (e.g. a retry race) doesn't abort the whole batch.
  const messageId = String(message._id);
  const expiresAt = daysFromNow(ENVELOPE_RETENTION_DAYS);
  const envelopeDocs = envelopes.map((env) => ({
    messageId,
    conversationId,
    senderId: userId,
    senderDeviceId,
    recipientUserId: env.recipientUserId,
    recipientDeviceId: env.recipientDeviceId,
    ciphertext: env.ciphertext,
    mediaKeys: env.mediaKeys && env.mediaKeys.length > 0 ? env.mediaKeys : undefined,
    expiresAt,
  }));
  try {
    await MessageEnvelope.insertMany(envelopeDocs, { ordered: false });
  } catch (err) {
    // Duplicate-key races (same envelope inserted twice) are benign and the
    // surviving envelopes are already persisted, so we keep the message.
    // Any other bulk failure is a partial write: clean up the just-created
    // Message (and any envelopes that did land) so no zombie with an inflated
    // envelopeCount is left behind, then rethrow for a 500.
    if (!isDuplicateKeyError(err)) {
      await MessageEnvelope.deleteMany({ messageId });
      await Message.deleteOne({ _id: message._id });
      throw err;
    }
  }

  // Update conversation metadata. v3 never carries plaintext, so the preview is
  // always the encrypted placeholder.
  conversation.lastMessageAt = new Date();
  conversation.lastMessage = {
    text: "[Encrypted]",
    senderId: userId,
    timestamp: new Date(),
  };
  const unreadCounts = conversation.unreadCounts as Map<string, number>;
  conversation.participants.forEach((participant) => {
    if (participant.userId !== userId) {
      const currentCount = unreadCounts.get(participant.userId) || 0;
      unreadCounts.set(participant.userId, currentCount + 1);
    }
  });
  await conversation.save();

  // Real-time fan-out: one device-addressed newMessage per envelope (carrying
  // that device's ciphertext), plus a lightweight conversationActivity to each
  // participant's user room for badges / list refresh.
  const messagingNamespace = getMessagingNamespace();
  if (messagingNamespace) {
    const baseMessage = message.toObject();
    const createdAt = message.createdAt;
    for (const env of envelopes) {
      const perDevicePayload = {
        ...baseMessage,
        ciphertext: env.ciphertext,
        ...(env.mediaKeys && env.mediaKeys.length > 0 ? { mediaKeys: env.mediaKeys } : {}),
      };
      messagingNamespace
        .to(deviceRoom(env.recipientUserId, env.recipientDeviceId))
        .emit("newMessage", perDevicePayload);
    }
    for (const participant of conversation.participants) {
      messagingNamespace.to(`user:${participant.userId}`).emit("conversationActivity", {
        conversationId,
        messageId,
        senderId: userId,
        createdAt,
      });
    }
  } else {
    console.error("[Messages] Socket.IO not available - envelopes will not be sent via socket");
  }

  return sendSuccessResponse(res, 201, message);
}

const DUPLICATE_KEY_CODE = 11000;

/** Extract a write-error code from either `we.code` or the wrapped `we.err.code`. */
function writeErrorCode(we: { code?: number; err?: { code?: number } }): number | undefined {
  return we.code ?? we.err?.code;
}

/**
 * True when a thrown error is a MongoDB duplicate-key (E11000) error. Handles
 * both single-document errors (`err.code`) and `insertMany(ordered:false)` which
 * throws a `MongoBulkWriteError` whose top-level `code` may be undefined and
 * whose per-document errors live in `writeErrors[n]` (the code is exposed either
 * as `writeErrors[n].code` or, in Mongoose, the wrapped `writeErrors[n].err.code`).
 * Returns true only when EVERY write error is a duplicate (failure is benign).
 */
function isDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    name?: string;
    code?: unknown;
    writeErrors?: Array<{ code?: number; err?: { code?: number } }>;
  };
  if (e.name === "MongoBulkWriteError" && Array.isArray(e.writeErrors)) {
    return (
      e.writeErrors.length > 0 &&
      e.writeErrors.every((we) => writeErrorCode(we) === DUPLICATE_KEY_CODE)
    );
  }
  return e.code === DUPLICATE_KEY_CODE;
}

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
      // Structured attachment metadata (public)
      attachmentType,
      location,
      contact,
      poll,
      forwardedFrom,
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

    // v3 (per-device envelope) messages take a dedicated, self-contained path so
    // the legacy v1/v2 single-blob flow below stays unchanged.
    if (Number(encryptionVersion) === ENCRYPTION_VERSION_ENVELOPES) {
      // v3 carries ciphertext only inside per-device envelopes. A request that
      // also sets a top-level ciphertext or plaintext text is malformed (the
      // top-level fields would be silently dropped), so reject it explicitly.
      if (ciphertext || text) {
        return res.status(400).json({
          error: "invalid_v3_payload",
          message: "encryptionVersion 3 must not include top-level ciphertext or text",
        });
      }
      return handleEnvelopeMessage(res, userId, conversation, {
        conversationId,
        senderDeviceId: Number(senderDeviceId),
        envelopes: req.body.envelopes,
        messageType,
        replyTo,
        fontSize,
        forwardedFrom,
        attachmentType,
        encryptedMedia,
      });
    }

    // Check if message has encrypted content, legacy plaintext, or a structured attachment
    const hasEncrypted = ciphertext || (encryptedMedia && encryptedMedia.length > 0);
    const hasLegacy = text || (media && media.length > 0);
    const hasAttachment = Boolean(attachmentType || location || contact || poll);

    if (!hasEncrypted && !hasLegacy && !hasAttachment) {
      return sendErrorResponse(res, 400, "Bad Request", "Message must have either encrypted content, legacy plaintext, or a structured attachment");
    }

    // Structural validation of encrypted payloads (backend never sees plaintext)
    if (hasEncrypted) {
      const valid = validateEncryptedMessage({
        ciphertext,
        encryptedMedia,
        encryptionVersion: encryptionVersion !== undefined ? Number(encryptionVersion) : undefined,
        messageType,
      });
      if (!valid) {
        return sendErrorResponse(res, 400, "Bad Request", "Malformed encrypted message payload");
      }
    }

    // Sanitize poll input to ensure votes arrays start empty
    let sanitizedPoll: PollData | undefined = undefined;
    if (poll && typeof poll === "object") {
      const pollInput = poll as { question?: unknown; options?: unknown; multi?: unknown };
      const question = typeof pollInput.question === "string" ? pollInput.question.trim() : "";
      const options = Array.isArray(pollInput.options) ? pollInput.options : [];
      if (question && options.length >= 2 && options.length <= 10) {
        const sanitizedOptions = options
          .slice(0, 10)
          .map((opt: unknown) => {
            const text =
              typeof opt === "string"
                ? opt
                : opt && typeof opt === "object" && typeof (opt as { text?: unknown }).text === "string"
                  ? (opt as { text: string }).text
                  : "";
            return { text, votes: [] as string[] };
          })
          .filter((opt) => opt.text.trim().length > 0);
        if (sanitizedOptions.length >= 2) {
          sanitizedPoll = {
            question,
            multi: Boolean(pollInput.multi),
            closed: false,
            options: sanitizedOptions,
          };
        }
      }
    }

    // Create message (encrypted, plaintext, or structured attachment)
    const message = await Message.create({
      conversationId,
      senderId: userId,
      senderDeviceId: Number(senderDeviceId),
      // Encrypted content
      ciphertext,
      encryptedMedia,
      encryptionVersion: encryptionVersion || (hasEncrypted ? 2 : 1),
      messageType:
        messageType ||
        (encryptedMedia
          ? "media"
          : attachmentType === "location"
            ? "location"
            : attachmentType === "contact"
              ? "contact"
              : attachmentType === "poll"
                ? "poll"
                : attachmentType === "file"
                  ? "file"
                  : attachmentType === "audio"
                    ? "audio"
                    : attachmentType
                      ? "media"
                      : "text"),
      // Legacy plaintext (deprecated)
      text,
      media,
      // Structured attachment metadata
      attachmentType,
      location,
      contact,
      poll: sanitizedPoll,
      forwardedFrom,
      replyTo,
      fontSize,
      deliveredTo: [userId], // Sender has received their own message
    });

    // Update conversation's last message
    conversation.lastMessageAt = new Date();
    // For encrypted messages, don't store plaintext preview
    let lastMessageText: string;
    if (ciphertext) {
      lastMessageText = "[Encrypted]";
    } else if (text) {
      lastMessageText = text;
    } else if (attachmentType === "location") {
      lastMessageText = "📍 Location";
    } else if (attachmentType === "contact") {
      lastMessageText = `👤 ${contact?.name ?? "Contact"}`;
    } else if (attachmentType === "poll") {
      lastMessageText = `📊 ${poll?.question ?? "Poll"}`;
    } else if (attachmentType === "audio") {
      lastMessageText = "🎤 Voice message";
    } else if (attachmentType === "file") {
      lastMessageText = `📎 ${media?.[0]?.fileName ?? "File"}`;
    } else if (media && media.length > 0) {
      lastMessageText = `Sent ${media.length} media file(s)`;
    } else {
      lastMessageText = "";
    }
    conversation.lastMessage = {
      text: lastMessageText,
      senderId: userId,
      timestamp: new Date(),
    };

    // Increment unread counts for all participants except sender
    // Mongoose Map types need to be accessed as Maps, not Records
    const unreadCounts = (conversation as any).unreadCounts as Map<string, number>;
    conversation.participants.forEach((participant) => {
      if (participant.userId !== userId) {
        const currentCount = unreadCounts.get(participant.userId) || 0;
        unreadCounts.set(participant.userId, currentCount + 1);
      }
    });

    await conversation.save();

    // Emit real-time event to both conversation room AND all participant user rooms
    // This ensures users receive messages even when not viewing that conversation (like WhatsApp)
    const io = (global as any).io;
    if (io) {
      const messagingNamespace = io.of("/messaging");
      
      // Convert message to plain object for socket emission
      const messageData = message.toObject ? message.toObject() : message;
      
      // Emit to conversation room (for active viewers)
      messagingNamespace.to(`conversation:${conversationId}`).emit("newMessage", messageData);

      // Also emit to all participant user rooms (so users receive messages globally)
      // This allows messages to appear in conversation list even when not viewing that conversation
      conversation.participants.forEach((participant) => {
        messagingNamespace.to(`user:${participant.userId}`).emit("newMessage", messageData);
      });
    } else {
      console.error('[Messages] Socket.IO not available - messages will not be sent via socket');
    }

    // Interop bridge (F3.0): if this owner-sent plaintext message lands in a
    // bridged conversation, hand it to the outbound dispatcher (which queues it
    // and attempts delivery to the external network). Gated by the flag and by
    // `!message.external` — inbound bridged messages carry `external` and are
    // created by BridgeInboundService, never through this route, so they can
    // never re-enter the bridge here. dispatchSend never throws.
    if (conversation.bridge && isBridgeEnabled() && !message.external) {
      void BridgeService.dispatchSend(message, conversation);
    }

    return sendSuccessResponse(res, 201, message);
  } catch (err) {
    console.error("[Messages] Error sending message:", err);
    const errMessage = err instanceof Error ? err.message : "";
    if (errMessage.includes("must have either text or media")) {
      return sendErrorResponse(res, 400, "Bad Request", errMessage);
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
    // Mongoose Map types need to be accessed as Maps, not Records
    if (!message.reactions) {
      (message as any).reactions = new Map<string, string[]>();
    }
    const reactions = (message as any).reactions as Map<string, string[]>;

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
    const reactionsObj: Record<string, string[]> = {};
    reactions.forEach((userIds: string[], emojiKey: string) => {
      reactionsObj[emojiKey] = userIds;
    });

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
    console.error("[Messages] Error updating reaction:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to update reaction");
  }
});

/**
 * DELETE /api/messages/:id/reactions/:emoji
 * Remove the authenticated user's reaction for a specific emoji
 */
router.delete("/:id/reactions/:emoji", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id, emoji } = req.params;

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

    // Mongoose Map types need to be accessed as Maps, not Records
    const reactions = (message as any).reactions as Map<string, string[]> | undefined;
    const currentReactions = reactions?.get(emoji) || [];

    if (reactions && currentReactions.includes(userId)) {
      const remaining = currentReactions.filter((uid: string) => uid !== userId);
      if (remaining.length > 0) {
        reactions.set(emoji, remaining);
      } else {
        reactions.delete(emoji);
      }
      await message.save();
    }

    // Convert Map to plain object for socket emission and response
    const reactionsObj: Record<string, string[]> = {};
    if (reactions) {
      reactions.forEach((userIds: string[], emojiKey: string) => {
        reactionsObj[emojiKey] = userIds;
      });
    }

    // Emit real-time event (same event as POST /:id/reactions)
    const io = (global as any).io;
    if (io) {
      const messagingNamespace = io.of("/messaging");
      messagingNamespace
        .to(`conversation:${message.conversationId}`)
        .emit("messageReactionUpdated", {
          messageId: message._id,
          emoji,
          userId,
          hasReacted: false,
          reactions: reactionsObj,
        });
    }

    return sendSuccessResponse(res, 200, {
      messageId: message._id,
      emoji,
      hasReacted: false,
      reactions: reactionsObj,
    });
  } catch (err) {
    console.error("[Messages] Error removing reaction:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to remove reaction");
  }
});

/**
 * DELETE /api/messages/:id
 * Delete a message
 *
 * Query/body `scope`:
 *   - "me" (default if not sender): only hide for the current user (adds userId to hiddenFor)
 *   - "everyone": soft-delete for all participants (only allowed for the sender)
 */
router.delete("/:id", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;
    const scopeRaw = (req.query.scope || req.body?.scope || "").toString();
    const scope: "me" | "everyone" = scopeRaw === "everyone" ? "everyone" : "me";

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
      return sendErrorResponse(res, 403, "Forbidden", "Access denied");
    }

    const io = (global as any).io;
    const messagingNamespace = io ? io.of("/messaging") : null;

    if (scope === "everyone") {
      // Only the sender can delete for everyone
      if (message.senderId !== userId) {
        return sendErrorResponse(res, 403, "Forbidden", "Only the sender can delete for everyone");
      }
      // Soft delete: clear content but keep a tombstone
      message.deletedAt = new Date();
      message.text = undefined;
      message.ciphertext = undefined;
      message.media = [] as any;
      message.encryptedMedia = [] as any;
      message.attachmentType = undefined;
      message.location = undefined;
      message.contact = undefined;
      message.poll = undefined;
      message.envelopeCount = 0;
      await message.save();

      // Discard all per-device envelopes so no device can hydrate the deleted
      // ciphertext (the message is gone for everyone, including offline devices).
      await MessageEnvelope.deleteMany({ messageId: String(message._id) });

      if (messagingNamespace) {
        messagingNamespace
          .to(`conversation:${message.conversationId}`)
          .emit("messageDeleted", { id: message._id, scope: "everyone" });
      }

      return sendSuccessResponse(res, 200, { id: message._id, deleted: true, scope });
    }

    // scope === "me" — hide for current user only
    const hidden = Array.isArray(message.hiddenFor) ? message.hiddenFor : [];
    if (!hidden.includes(userId)) {
      hidden.push(userId);
      message.hiddenFor = hidden;
      await message.save();
    }

    if (messagingNamespace) {
      messagingNamespace
        .to(`user:${userId}`)
        .emit("messageDeleted", { id: message._id, scope: "me", userId });
    }

    return sendSuccessResponse(res, 200, { id: message._id, deleted: true, scope });
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
    // Mongoose Map types need to be accessed as Maps, not Records
    const readBy = (message as any).readBy as Map<string, Date>;
    const readAt = new Date();
    readBy.set(userId, readAt);
    await message.save();

    // Notify the conversation (for the sender's read receipt) and the reader's
    // own user room (so their other devices sync the read state).
    const messagingNamespace = getMessagingNamespace();
    if (messagingNamespace) {
      const readEvent = {
        conversationId: message.conversationId,
        messageId: String(message._id),
        userId,
        readAt,
      };
      messagingNamespace.to(`conversation:${message.conversationId}`).emit("messageRead", readEvent);
      messagingNamespace.to(`user:${userId}`).emit("messageRead", readEvent);
    }

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

    // For v3, mark this device's envelope delivered and shorten its TTL so
    // delivered ciphertext is reaped sooner (see ENVELOPE_DELIVERED_RETENTION_DAYS).
    // Skip the sender: their own per-device "sync" envelopes power multi-device
    // catch-up, so a sender's delivered call must not shorten their own TTLs.
    const deviceId = getRequestDeviceId(req);
    if (deviceId !== null && userId !== message.senderId) {
      await MessageEnvelope.updateOne(
        {
          messageId: String(message._id),
          recipientUserId: userId,
          recipientDeviceId: deviceId,
        },
        {
          $set: {
            deliveredAt: new Date(),
            expiresAt: daysFromNow(ENVELOPE_DELIVERED_RETENTION_DAYS),
          },
        }
      );
    }

    // Mark as delivered (per-user, first delivery wins) — keeps existing
    // conversation-level delivery semantics for v1/v2 and v3 alike.
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

/**
 * Run multer's single-file middleware, translating filter/limit errors into a
 * clean 400 instead of letting them bubble to the generic error handler.
 */
const uploadSingleFile = (req: AuthRequest, res: Response, next: () => void) => {
  upload.single("file")(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : "Upload failed";
      return sendErrorResponse(res, 400, "Bad Request", message);
    }
    next();
  });
};

/**
 * POST /api/messages/upload
 * Upload an attachment file (image, video, audio, file)
 * Returns { id, url, fileName, mimeType, size }
 *
 * Note: this is a local-disk fallback. The primary path is uploading
 * through `@oxyhq/services` (oxyServices.assetUpload) from the frontend.
 */
router.post(
  "/upload",
  uploadSingleFile,
  async (req: AuthRequest, res: Response) => {
    try {
      getAuthenticatedUserId(req); // throws if not authenticated
      const file = req.file;
      if (!file) {
        return sendErrorResponse(res, 400, "Bad Request", "No file uploaded");
      }

      const url = `/uploads/${file.filename}`;
      return sendSuccessResponse(res, 201, {
        id: file.filename,
        url,
        fileName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
      });
    } catch (err) {
      console.error("[Messages] Error uploading file:", err);
      return sendErrorResponse(res, 500, "Internal Server Error", "Failed to upload file");
    }
  }
);

/**
 * POST /api/messages/:id/poll/vote
 * Vote (or change vote) on a poll attached to a message
 * Body: { optionIndexes: number[] }
 */
router.post("/:id/poll/vote", async (req: AuthRequest, res: Response) => {
  try {
    const userId = getAuthenticatedUserId(req);
    const { id } = req.params;
    const { optionIndexes } = req.body as { optionIndexes?: number[] };

    if (!Array.isArray(optionIndexes) || optionIndexes.some((i) => !Number.isInteger(i) || i < 0)) {
      return sendErrorResponse(res, 400, "Bad Request", "optionIndexes must be an array of non-negative integers");
    }

    const message = await Message.findById(id);
    if (!message || !message.poll) {
      return sendErrorResponse(res, 404, "Not Found", "Poll not found");
    }

    // Verify user is a participant
    const conversation = await Conversation.findOne({
      _id: message.conversationId,
      "participants.userId": userId,
    });
    if (!conversation) {
      return sendErrorResponse(res, 403, "Forbidden", "Access denied");
    }

    if (message.poll.closed) {
      return sendErrorResponse(res, 409, "Conflict", "Poll is closed");
    }

    const validIndexes = optionIndexes.filter((i) => i < message.poll!.options.length);
    if (validIndexes.length === 0) {
      return sendErrorResponse(res, 400, "Bad Request", "No valid option indexes");
    }

    const allowedIndexes = message.poll.multi ? validIndexes : validIndexes.slice(0, 1);
    const allowedSet = new Set<number>(allowedIndexes);

    // Atomic update: rebuild option votes arrays
    message.poll.options = message.poll.options.map((opt, idx) => {
      const votes = (opt.votes || []).filter((uid: string) => uid !== userId);
      if (allowedSet.has(idx)) {
        votes.push(userId);
      }
      return { text: opt.text, votes };
    });

    message.markModified("poll");
    await message.save();

    // Emit real-time event
    const io = (global as any).io;
    if (io) {
      const messagingNamespace = io.of("/messaging");
      messagingNamespace
        .to(`conversation:${message.conversationId}`)
        .emit("messageUpdated", message.toObject ? message.toObject() : message);
    }

    return sendSuccessResponse(res, 200, {
      messageId: message._id,
      poll: message.poll,
    });
  } catch (err) {
    console.error("[Messages] Error voting in poll:", err);
    return sendErrorResponse(res, 500, "Internal Server Error", "Failed to vote in poll");
  }
});

export default router;

