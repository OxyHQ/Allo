import { Namespace, Socket } from "socket.io";
import { logger } from "./logger";

interface AuthenticatedSocket extends Socket {
  user?: { id: string; [key: string]: unknown };
  /** Resolved at handshake time (server.ts) when the client claims a device id. */
  signalDeviceId?: number;
}

interface OfferPayload {
  to: string;
  /** Device-addressed routing target (Fase 1C). Optional; legacy clients omit it. */
  toDeviceId?: number;
  sdp: unknown;
  sessionId: string;
}

interface AnswerPayload {
  to: string;
  toDeviceId?: number;
  sdp: unknown;
  sessionId: string;
}

interface IcePayload {
  to: string;
  toDeviceId?: number;
  candidate: unknown;
  sessionId: string;
}

interface ClosePayload {
  to: string;
  toDeviceId?: number;
  sessionId: string;
}

type Ack = (response: { ok: boolean; error?: string }) => void;

/**
 * Resolved signaling route: the room to emit into plus the `fromDeviceId` (if any)
 * stamped onto the forwarded event so the recipient device can address replies.
 */
export interface SignalingRoute {
  room: string;
  /** The sender's device id, echoed so the peer can target it on the way back. */
  fromDeviceId?: number;
}

/**
 * Validate a device id claimed in a signaling payload. Device ids are positive
 * integers (the Signal device numbering starts at 1). Anything else is rejected.
 */
export function isValidDeviceId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * Decide where a P2P signaling event should be routed, or reject it.
 *
 * Two modes:
 *  1. **Cross-user (legacy)**: `toDeviceId` absent → route to `user:<to>`. The
 *     target user must differ from the sender (no same-user signaling without a
 *     device address — that path is reserved for history transfer).
 *  2. **Device-addressed (Fase 1C)**: `toDeviceId` present → route to
 *     `device:<to>:<toDeviceId>`. This mode REQUIRES an identified sender
 *     (`fromDeviceId`): without one the self-signal guard below can't fire, so a
 *     legacy/unidentified client could otherwise target ANY user's private
 *     device room. Same-user signaling is ALLOWED here, but only to a DIFFERENT
 *     device than the sender's own (a device never signals itself). The device
 *     id must be a positive integer.
 *
 * Pure and dependency-free so the routing rules can be unit-tested without a
 * live Socket.IO server.
 *
 * @param fromUserId    Authenticated sender user id.
 * @param fromDeviceId  Sender's resolved device id (from the handshake), if any.
 * @param to            Target user id from the payload.
 * @param toDeviceId    Optional target device id from the payload.
 */
export function resolveSignalingRoute(
  fromUserId: string,
  fromDeviceId: number | undefined,
  to: unknown,
  toDeviceId: unknown
): SignalingRoute | null {
  if (typeof to !== "string" || to.length === 0) {
    return null;
  }

  // Device-addressed routing (covers same-user history transfer).
  if (toDeviceId !== undefined && toDeviceId !== null) {
    if (!isValidDeviceId(toDeviceId)) {
      return null;
    }
    // Device-addressed signaling requires an identified sender. A client that
    // never claimed a device id at handshake must not be able to reach a
    // specific device room — the self-signal guard relies on `fromDeviceId`, so
    // without it an unidentified client could target any user's device room.
    if (fromDeviceId === undefined) {
      return null;
    }
    // A device must never signal itself: same user AND same device is rejected.
    if (to === fromUserId && toDeviceId === fromDeviceId) {
      return null;
    }
    return { room: `device:${to}:${toDeviceId}`, fromDeviceId };
  }

  // Legacy cross-user routing: no same-user signaling without a device address.
  if (to === fromUserId) {
    return null;
  }
  return { room: `user:${to}`, fromDeviceId };
}

function isValidSession(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 128;
}

/**
 * Stateless WebRTC signaling for P2P data-channel messaging.
 *
 * Mirrors `registerCallSignaling` but is intentionally ephemeral: the server
 * never persists offers/answers/ICE, it only forwards them to the recipient's
 * `user:<id>` room (default) or, when the payload carries `toDeviceId`, to a
 * specific `device:<id>:<deviceId>` room. The latter enables same-user
 * device-to-device signaling used by the WhatsApp-style history transfer
 * (Fase 1C): the encrypted history rides a P2P data channel between two devices
 * of the SAME account, and the server only forwards SDP/ICE — never content.
 *
 * The sender's device id (set on `socket.signalDeviceId` at handshake) is echoed
 * to the recipient as `fromDeviceId` so the peer can address replies back to the
 * exact originating device.
 *
 * Events forwarded:
 *  - `p2p:offer`  { to, toDeviceId?, sdp, sessionId }
 *      → `p2p:offer`  { from, fromDeviceId?, sdp, sessionId }
 *  - `p2p:answer` { to, toDeviceId?, sdp, sessionId }
 *      → `p2p:answer` { from, fromDeviceId?, sdp, sessionId }
 *  - `p2p:ice`    { to, toDeviceId?, candidate, sessionId }
 *      → `p2p:ice`    { from, fromDeviceId?, candidate, sessionId }
 *  - `p2p:close`  { to, toDeviceId?, sessionId }
 *      → `p2p:close`  { from, fromDeviceId?, sessionId }
 */
export function registerP2PSignaling(messagingNamespace: Namespace) {
  messagingNamespace.on("connection", (socket: AuthenticatedSocket) => {
    if (!socket.user?.id) {
      return;
    }
    const userId = socket.user.id;

    socket.on("p2p:offer", (payload: OfferPayload, ack?: Ack) => {
      try {
        const { to, toDeviceId, sdp, sessionId } = payload || ({} as OfferPayload);
        const route = resolveSignalingRoute(userId, socket.signalDeviceId, to, toDeviceId);
        if (!route || !isValidSession(sessionId) || !sdp) {
          ack?.({ ok: false, error: "Invalid p2p:offer payload" });
          return;
        }
        messagingNamespace.to(route.room).emit("p2p:offer", {
          from: userId,
          fromDeviceId: route.fromDeviceId,
          sdp,
          sessionId,
        });
        ack?.({ ok: true });
      } catch (err) {
        logger.error("[P2PSignaling] p2p:offer error", err);
        ack?.({ ok: false, error: "Failed to forward offer" });
      }
    });

    socket.on("p2p:answer", (payload: AnswerPayload, ack?: Ack) => {
      try {
        const { to, toDeviceId, sdp, sessionId } = payload || ({} as AnswerPayload);
        const route = resolveSignalingRoute(userId, socket.signalDeviceId, to, toDeviceId);
        if (!route || !isValidSession(sessionId) || !sdp) {
          ack?.({ ok: false, error: "Invalid p2p:answer payload" });
          return;
        }
        messagingNamespace.to(route.room).emit("p2p:answer", {
          from: userId,
          fromDeviceId: route.fromDeviceId,
          sdp,
          sessionId,
        });
        ack?.({ ok: true });
      } catch (err) {
        logger.error("[P2PSignaling] p2p:answer error", err);
        ack?.({ ok: false, error: "Failed to forward answer" });
      }
    });

    socket.on("p2p:ice", (payload: IcePayload, ack?: Ack) => {
      try {
        const { to, toDeviceId, candidate, sessionId } = payload || ({} as IcePayload);
        const route = resolveSignalingRoute(userId, socket.signalDeviceId, to, toDeviceId);
        if (!route || !isValidSession(sessionId)) {
          ack?.({ ok: false, error: "Invalid p2p:ice payload" });
          return;
        }
        // `candidate` may legitimately be null (end-of-candidates marker).
        messagingNamespace.to(route.room).emit("p2p:ice", {
          from: userId,
          fromDeviceId: route.fromDeviceId,
          candidate: candidate ?? null,
          sessionId,
        });
        ack?.({ ok: true });
      } catch (err) {
        logger.error("[P2PSignaling] p2p:ice error", err);
        ack?.({ ok: false, error: "Failed to forward candidate" });
      }
    });

    socket.on("p2p:close", (payload: ClosePayload, ack?: Ack) => {
      try {
        const { to, toDeviceId, sessionId } = payload || ({} as ClosePayload);
        const route = resolveSignalingRoute(userId, socket.signalDeviceId, to, toDeviceId);
        if (!route || !isValidSession(sessionId)) {
          ack?.({ ok: false, error: "Invalid p2p:close payload" });
          return;
        }
        messagingNamespace.to(route.room).emit("p2p:close", {
          from: userId,
          fromDeviceId: route.fromDeviceId,
          sessionId,
        });
        ack?.({ ok: true });
      } catch (err) {
        logger.error("[P2PSignaling] p2p:close error", err);
        ack?.({ ok: false, error: "Failed to forward close" });
      }
    });
  });
}
