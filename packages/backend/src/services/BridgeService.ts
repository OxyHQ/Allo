import crypto from "crypto";
import type { Namespace } from "socket.io";
import type { BridgeCommand, BridgeMediaRef } from "@allo/shared-types";
import Message, { type IMessage } from "../models/Message";
import { IConversation } from "../models/Conversation";
import BridgeOutbox, { type IBridgeOutbox } from "../models/BridgeOutbox";
import { logger } from "../utils/logger";
import {
  getBridgeSharedSecret,
  getBridgeServiceUrl,
  BRIDGE_TIMESTAMP_HEADER,
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_OUTBOX_MAX_ATTEMPTS,
  BRIDGE_OUTBOX_SWEEP_INTERVAL_MS,
  computeBackoffMs,
} from "../config/bridge";

/**
 * BridgeService — the OUTBOUND half of the interop seam (Allo -> external).
 *
 * Owner-originated messages to a bridged conversation are persisted to a durable
 * `BridgeOutbox` and POSTed to the connector with an HMAC signature. A sweeper
 * retries pending rows with exponential backoff until they succeed or exhaust
 * `BRIDGE_OUTBOX_MAX_ATTEMPTS`.
 */

const SUCCESS_STATUS_MIN = 200;
const SUCCESS_STATUS_MAX = 300;

/** HTTP 2xx check for connector responses. */
function isOk(status: number): boolean {
  return status >= SUCCESS_STATUS_MIN && status < SUCCESS_STATUS_MAX;
}

/**
 * Resolve the Socket.IO `/messaging` namespace, or null when sockets aren't
 * wired (e.g. unit tests). Resolved the same way the message routes do.
 */
function getMessagingNamespace(): Namespace | null {
  const io = (global as { io?: { of: (nsp: string) => Namespace } }).io;
  return io ? io.of("/messaging") : null;
}

/**
 * Sign a raw request body for the connector. Canonical form matches
 * `bridgeAuth`: HMAC-SHA256(secret, `${timestamp}.${rawBody}`) as hex. Exported
 * so the user-facing bridge routes reuse the exact same signing.
 *
 * @throws if `BRIDGE_SHARED_SECRET` is unset (callers wrap in try/catch).
 */
export function signBridgeRequest(rawBody: string): { timestamp: string; signature: string } {
  const secret = getBridgeSharedSecret();
  if (!secret) {
    throw new Error("BRIDGE_SHARED_SECRET is not configured");
  }
  const timestamp = String(Date.now());
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return { timestamp, signature };
}

/** Build the signed headers for a connector POST with the given JSON body. */
function signedHeaders(rawBody: string): Record<string, string> {
  const { timestamp, signature } = signBridgeRequest(rawBody);
  return {
    "Content-Type": "application/json",
    [BRIDGE_TIMESTAMP_HEADER]: timestamp,
    [BRIDGE_SIGNATURE_HEADER]: signature,
  };
}

/** Map a stored MediaItem to the wire BridgeMediaRef shape. */
function toBridgeMedia(media: IMessage["media"]): BridgeMediaRef[] | undefined {
  if (!media || media.length === 0) return undefined;
  return media.map((m) => ({
    id: m.id,
    url: m.url,
    type: m.type,
    fileName: m.fileName,
    mimeType: m.mimeType,
    fileSize: m.fileSize,
    width: m.width,
    height: m.height,
    duration: m.duration,
  }));
}

/** POST a BridgeCommand to the connector's `/commands` endpoint. */
async function postCommand(command: BridgeCommand): Promise<Response> {
  const baseUrl = getBridgeServiceUrl();
  if (!baseUrl) {
    throw new Error("BRIDGE_SERVICE_URL is not configured");
  }
  const rawBody = JSON.stringify(command);
  return fetch(`${baseUrl}/commands`, {
    method: "POST",
    headers: signedHeaders(rawBody),
    body: rawBody,
  });
}

/**
 * Emit a `messageUpdated` event for a message to its conversation room, mirroring
 * the routes' fan-out. No-op when sockets aren't wired.
 */
function emitMessageUpdated(message: IMessage): void {
  const ns = getMessagingNamespace();
  if (!ns) return;
  ns.to(`conversation:${message.conversationId}`).emit("messageUpdated", message.toObject());
}

/**
 * Queue an owner-originated message for delivery to the bridged external chat.
 *
 * Persists a pending BridgeOutbox row, marks the message `external.bridgeStatus
 * = 'queued'`, then attempts an immediate delivery. Any failure leaves the row
 * pending for the sweeper. NEVER throws — the POST path calls this as
 * `void dispatchSend(...)`.
 */
export async function dispatchSend(
  message: IMessage,
  conversation: IConversation
): Promise<void> {
  try {
    const bridge = conversation.bridge;
    if (!bridge) {
      logger.error("dispatchSend called for a non-bridged conversation; skipping");
      return;
    }

    const command: BridgeCommand = {
      v: 1,
      type: "send",
      network: bridge.network,
      ownerUserId: bridge.ownerUserId,
      externalChatId: bridge.externalChatId,
      messageId: String(message._id),
      text: message.text,
      media: toBridgeMedia(message.media),
    };

    const outbox = await BridgeOutbox.create({
      messageId: String(message._id),
      command,
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
    });

    // Owner-originated send: there is no external sender/message id yet, but the
    // sub-schema requires `network`, so set it alongside the queued status.
    message.external = {
      ...(message.external ?? {}),
      network: bridge.network,
      bridgeStatus: "queued",
    };
    await message.save();

    if (!getBridgeServiceUrl()) {
      logger.warn("BRIDGE_SERVICE_URL unset; message queued, awaiting configuration");
      return;
    }

    try {
      const response = await postCommand(command);
      if (isOk(response.status)) {
        outbox.status = "sent";
        await outbox.save();
      } else {
        // Leave pending at attempts 0 with nextAttemptAt=now so the next sweep
        // retries promptly.
        logger.warn(`Immediate bridge send returned ${response.status}; left pending`);
      }
    } catch (postError) {
      logger.error("Immediate bridge send failed; left pending for sweeper", postError);
    }
  } catch (error) {
    logger.error("dispatchSend failed", error);
  }
}

/**
 * Mark an outbox row (and its message) as permanently failed after exhausting
 * retries, and notify the conversation so the UI can show the failure.
 */
async function failOutbox(outbox: IBridgeOutbox): Promise<void> {
  outbox.status = "failed";
  await outbox.save();
  const message = await Message.findById(outbox.messageId);
  if (message && message.external) {
    // The message was queued via dispatchSend, so `external.network` is set;
    // flip the delivery status to failed and notify the conversation.
    message.external.bridgeStatus = "failed";
    await message.save();
    emitMessageUpdated(message);
  }
}

/**
 * Single sweep pass over due pending outbox rows. Exported for tests so retry
 * behavior can be driven deterministically (no real timers).
 */
export async function processOutboxOnce(): Promise<void> {
  const now = new Date();
  const due = await BridgeOutbox.find({ status: "pending", nextAttemptAt: { $lte: now } });

  for (const outbox of due) {
    try {
      if (!getBridgeServiceUrl()) {
        logger.warn("BRIDGE_SERVICE_URL unset; treating outbox row as a failed attempt");
        outbox.attempts += 1;
        if (outbox.attempts >= BRIDGE_OUTBOX_MAX_ATTEMPTS) {
          await failOutbox(outbox);
        } else {
          outbox.nextAttemptAt = new Date(Date.now() + computeBackoffMs(outbox.attempts));
          await outbox.save();
        }
        continue;
      }

      let ok = false;
      try {
        const response = await postCommand(outbox.command);
        ok = isOk(response.status);
        if (!ok) {
          outbox.lastError = `connector responded ${response.status}`;
        }
      } catch (postError) {
        outbox.lastError = postError instanceof Error ? postError.message : "send failed";
      }

      if (ok) {
        outbox.status = "sent";
        await outbox.save();
        continue;
      }

      outbox.attempts += 1;
      if (outbox.attempts >= BRIDGE_OUTBOX_MAX_ATTEMPTS) {
        await failOutbox(outbox);
      } else {
        outbox.nextAttemptAt = new Date(Date.now() + computeBackoffMs(outbox.attempts));
        await outbox.save();
      }
    } catch (error) {
      logger.error("Failed to process outbox row", error);
    }
  }
}

let sweeperHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the background outbox sweeper. Idempotent (a second call is a no-op).
 * Called ONLY from `bootServer()` when the bridge is enabled — never at import,
 * so tests that import this module don't spawn timers.
 */
export function startOutboxSweeper(): void {
  if (sweeperHandle !== null) return;
  sweeperHandle = setInterval(() => {
    void processOutboxOnce();
  }, BRIDGE_OUTBOX_SWEEP_INTERVAL_MS);
}

/** Stop the background outbox sweeper. */
export function stopOutboxSweeper(): void {
  if (sweeperHandle !== null) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
}
