import { Namespace, Socket } from "socket.io";
import Call, { CallType } from "../models/Call";
import { logger } from "./logger";
import {
  applyAccept,
  applyCancel,
  applyDecline,
  applyEnd,
  applyRingTimeout,
  resolveAnsweredElsewhereRooms,
  shouldAutoDeclineBusy,
  RING_TIMEOUT_MS,
  type CallSnapshot,
  type CallMutation,
} from "./callState";
import {
  addOnlineDevice,
  getActiveCall,
  getOnlineDeviceIds,
  getUserCallIds,
  isUserBusy,
  registerActiveCall,
  removeActiveCall,
  removeOnlineDevice,
  updateActiveCallStatus,
} from "./callRegistry";

interface AuthenticatedSocket extends Socket {
  user?: { id: string; [key: string]: unknown };
  /** Resolved Signal device id for this connection (set at handshake). */
  signalDeviceId?: number;
}

interface CallInvitePayload {
  callId?: string;
  calleeId: string;
  type: CallType;
  conversationId?: string;
}

interface CallActionPayload {
  callId: string;
}

interface CallSignalPayload {
  callId: string;
  to: string;
  payload: unknown;
}

type Ack = (response: { ok: boolean; callId?: string; error?: string }) => void;

/**
 * Track per-call ring timers so we can cancel them on accept/decline/cancel.
 * Module-scoped (per process) — consistent with the single-instance assumption
 * documented on the call registry and the server's lastSeen throttle.
 */
const ringTimers = new Map<string, NodeJS.Timeout>();

/**
 * Callee ids for which an invite is mid-flight (between the busy check passing
 * and `registerActiveCall` running after the `await Call.create`). Set
 * SYNCHRONOUSLY before any await so two concurrent `call:invite`s for the same
 * callee can't both read `isUserBusy === false` and stack two calls — the second
 * sees the sentinel and gets `busy`. Cleared in a `finally` once the call is
 * registered (or the attempt fails).
 */
const invitesInProgressByCallee = new Set<string>();

function clearRingTimer(callId: string): void {
  const t = ringTimers.get(callId);
  if (t) {
    clearTimeout(t);
    ringTimers.delete(callId);
  }
}

async function loadCallForUser(callId: string, userId: string) {
  const call = await Call.findById(callId);
  if (!call) {
    return null;
  }
  if (call.callerId !== userId && call.calleeId !== userId) {
    return null;
  }
  return call;
}

/** Snapshot the fields the pure state machine reasons about. */
function toSnapshot(call: {
  callerId: string;
  calleeId: string;
  status: CallSnapshot["status"];
  type: CallType;
  conversationId?: string;
  startedAt: Date;
  connectedAt?: Date;
}): CallSnapshot {
  return {
    callerId: call.callerId,
    calleeId: call.calleeId,
    status: call.status,
    type: call.type,
    conversationId: call.conversationId,
    startedAt: call.startedAt,
    connectedAt: call.connectedAt,
  };
}

/** Apply a state-machine mutation onto a Mongoose call doc. */
function applyMutation(
  call: {
    status: CallSnapshot["status"];
    connectedAt?: Date;
    endedAt?: Date;
    durationSec?: number;
    endedBy?: string;
  },
  mutation: CallMutation | undefined
): void {
  if (!mutation) return;
  if (mutation.status !== undefined) call.status = mutation.status;
  if (mutation.connectedAt !== undefined) call.connectedAt = mutation.connectedAt;
  if (mutation.endedAt !== undefined) call.endedAt = mutation.endedAt;
  if (mutation.durationSec !== undefined) call.durationSec = mutation.durationSec;
  if (mutation.endedBy !== undefined) call.endedBy = mutation.endedBy;
}

/**
 * Registers WebRTC signaling event handlers on the messaging namespace.
 * Called once after the namespace's `connection` listener is attached, so that
 * every newly connected socket also receives these handlers.
 *
 * Events handled:
 *  - call:invite     caller → server → callee (all devices ring)
 *  - call:accept     callee → server → both; OTHER callee devices get
 *                    `call:answered-elsewhere`
 *  - call:decline    callee → server → both (declines for all callee devices)
 *  - call:cancel     caller → server → both (before accept; dismisses all)
 *  - call:end        either → server → both
 *  - call:signal     either → server → other peer (SDP / ICE forwarding)
 *
 * Multi-device: the invite is emitted to `user:<calleeId>` so EVERY connected
 * device of the callee rings. On accept the accepting device id (from the
 * handshake) is excluded so its siblings self-dismiss.
 */
export function registerCallSignaling(messagingNamespace: Namespace) {
  messagingNamespace.on("connection", (socket: AuthenticatedSocket) => {
    if (!socket.user?.id) {
      return;
    }
    const userId = socket.user.id;
    const deviceId = socket.signalDeviceId;
    if (deviceId !== undefined) {
      addOnlineDevice(userId, deviceId);
    }

    // --- call:invite ---
    socket.on("call:invite", async (payload: CallInvitePayload, ack?: Ack) => {
      // Tracks whether THIS invite owns the per-callee in-progress sentinel, so
      // the `finally` only releases a sentinel we actually acquired.
      let sentinelCalleeId: string | null = null;
      try {
        const { calleeId, type, conversationId } = payload || ({} as CallInvitePayload);
        if (!calleeId || !type || (type !== "audio" && type !== "video")) {
          ack?.({ ok: false, error: "Invalid invite payload" });
          return;
        }
        if (calleeId === userId) {
          ack?.({ ok: false, error: "Cannot call yourself" });
          return;
        }

        // Busy: the callee is already ringing/connected on another call, OR
        // another invite for this callee is mid-flight (the sentinel below). We
        // reject up-front rather than create a doomed call doc; the caller
        // surfaces this as "user is busy". The sentinel closes the race where two
        // concurrent invites both read `isUserBusy === false` before either has
        // registered its call (registration happens after `await Call.create`).
        if (shouldAutoDeclineBusy(isUserBusy(calleeId)) || invitesInProgressByCallee.has(calleeId)) {
          ack?.({ ok: false, error: "busy" });
          logger.info(`[CallSignaling] invite ${userId} → ${calleeId} rejected: callee busy`);
          return;
        }
        // Caller is busy too — guard against starting a second outgoing call.
        if (isUserBusy(userId)) {
          ack?.({ ok: false, error: "already_in_call" });
          return;
        }

        // Claim the callee SYNCHRONOUSLY before the first await. From here a
        // concurrent invite for the same callee will see the sentinel and bail.
        invitesInProgressByCallee.add(calleeId);
        sentinelCalleeId = calleeId;

        const call = await Call.create({
          callerId: userId,
          calleeId,
          conversationId,
          type,
          status: "ringing",
          startedAt: new Date(),
        });

        const callId = String(call._id);
        registerActiveCall(callId, userId, calleeId, "ringing");

        const incomingPayload = {
          callId,
          callerId: userId,
          calleeId,
          type,
          conversationId,
          startedAt: call.startedAt,
        };

        // Ring ALL of the callee's devices, and echo to the caller's devices so
        // a second caller device reflects the active outgoing call.
        messagingNamespace.to(`user:${calleeId}`).emit("call:incoming", incomingPayload);
        messagingNamespace.to(`user:${userId}`).emit("call:ringing", incomingPayload);

        // Server-side ring timeout → mark missed if not accepted.
        const timer = setTimeout(() => {
          ringTimers.delete(callId);
          void handleRingTimeout(messagingNamespace, callId);
        }, RING_TIMEOUT_MS);
        ringTimers.set(callId, timer);

        ack?.({ ok: true, callId });
        logger.info(`[CallSignaling] invite ${userId} → ${calleeId} (${type}) call=${callId}`);
      } catch (err) {
        logger.error("[CallSignaling] call:invite error", err);
        ack?.({ ok: false, error: "Failed to start call" });
      } finally {
        // Release the in-progress claim. The call is now in the registry (so
        // `isUserBusy` covers it) — or the attempt failed and the callee is free.
        if (sentinelCalleeId !== null) {
          invitesInProgressByCallee.delete(sentinelCalleeId);
        }
      }
    });

    // --- call:accept ---
    socket.on("call:accept", async (payload: CallActionPayload, ack?: Ack) => {
      try {
        const { callId } = payload || ({} as CallActionPayload);
        if (!callId) {
          ack?.({ ok: false, error: "Missing callId" });
          return;
        }
        const call = await loadCallForUser(callId, userId);
        if (!call) {
          ack?.({ ok: false, error: "Call not found" });
          return;
        }

        const result = applyAccept(toSnapshot(call), userId, new Date());
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        clearRingTimer(callId);
        applyMutation(call, result.mutation);
        await call.save();
        updateActiveCallStatus(callId, "connected");

        const acceptedPayload = {
          callId,
          callerId: call.callerId,
          calleeId: call.calleeId,
          type: call.type,
          conversationId: call.conversationId,
          connectedAt: call.connectedAt,
        };
        messagingNamespace.to(`user:${call.callerId}`).emit("call:accepted", acceptedPayload);
        messagingNamespace.to(`user:${call.calleeId}`).emit("call:accepted", acceptedPayload);

        // Tell the callee's OTHER devices to stop ringing. We target each of the
        // callee's online device rooms except the one that accepted; the payload
        // also carries `answeringDeviceId` so clients can self-dismiss even when
        // the accepting device id is unknown (legacy clients).
        const answeredElsewhere = {
          callId,
          calleeId: call.calleeId,
          answeringDeviceId: socket.signalDeviceId,
        };
        const rooms = resolveAnsweredElsewhereRooms(
          call.calleeId,
          getOnlineDeviceIds(call.calleeId),
          socket.signalDeviceId
        );
        for (const room of rooms) {
          messagingNamespace.to(room).emit("call:answered-elsewhere", answeredElsewhere);
        }
        // Fallback for legacy clients with no device room: broadcast to the user
        // room and rely on the payload's answeringDeviceId for self-dismiss.
        if (rooms.length === 0) {
          messagingNamespace
            .to(`user:${call.calleeId}`)
            .emit("call:answered-elsewhere", answeredElsewhere);
        }

        ack?.({ ok: true });
        logger.info(`[CallSignaling] accepted call=${callId} by ${userId}`);
      } catch (err) {
        logger.error("[CallSignaling] call:accept error", err);
        ack?.({ ok: false, error: "Failed to accept call" });
      }
    });

    // --- call:decline ---
    socket.on("call:decline", async (payload: CallActionPayload, ack?: Ack) => {
      try {
        const { callId } = payload || ({} as CallActionPayload);
        if (!callId) {
          ack?.({ ok: false, error: "Missing callId" });
          return;
        }
        const call = await loadCallForUser(callId, userId);
        if (!call) {
          ack?.({ ok: false, error: "Call not found" });
          return;
        }
        const result = applyDecline(toSnapshot(call), userId, new Date());
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        clearRingTimer(callId);
        applyMutation(call, result.mutation);
        await call.save();
        removeActiveCall(callId);

        const declinedPayload = {
          callId,
          callerId: call.callerId,
          calleeId: call.calleeId,
          endedBy: userId,
        };
        // Decline from one device declines for ALL: every callee device + the
        // caller get the event (WhatsApp behaviour).
        messagingNamespace.to(`user:${call.callerId}`).emit("call:declined", declinedPayload);
        messagingNamespace.to(`user:${call.calleeId}`).emit("call:declined", declinedPayload);
        ack?.({ ok: true });
        logger.info(`[CallSignaling] declined call=${callId} by ${userId}`);
      } catch (err) {
        logger.error("[CallSignaling] call:decline error", err);
        ack?.({ ok: false, error: "Failed to decline call" });
      }
    });

    // --- call:cancel ---
    socket.on("call:cancel", async (payload: CallActionPayload, ack?: Ack) => {
      try {
        const { callId } = payload || ({} as CallActionPayload);
        if (!callId) {
          ack?.({ ok: false, error: "Missing callId" });
          return;
        }
        const call = await loadCallForUser(callId, userId);
        if (!call) {
          ack?.({ ok: false, error: "Call not found" });
          return;
        }
        const result = applyCancel(toSnapshot(call), userId, new Date());
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        clearRingTimer(callId);
        applyMutation(call, result.mutation);
        await call.save();
        removeActiveCall(callId);

        const canceledPayload = {
          callId,
          callerId: call.callerId,
          calleeId: call.calleeId,
          endedBy: userId,
        };
        // Cancel dismisses ALL ringing callee devices.
        messagingNamespace.to(`user:${call.callerId}`).emit("call:canceled", canceledPayload);
        messagingNamespace.to(`user:${call.calleeId}`).emit("call:canceled", canceledPayload);
        ack?.({ ok: true });
        logger.info(`[CallSignaling] canceled call=${callId} by ${userId}`);
      } catch (err) {
        logger.error("[CallSignaling] call:cancel error", err);
        ack?.({ ok: false, error: "Failed to cancel call" });
      }
    });

    // --- call:end ---
    socket.on("call:end", async (payload: CallActionPayload, ack?: Ack) => {
      try {
        const { callId } = payload || ({} as CallActionPayload);
        if (!callId) {
          ack?.({ ok: false, error: "Missing callId" });
          return;
        }
        const call = await loadCallForUser(callId, userId);
        if (!call) {
          ack?.({ ok: false, error: "Call not found" });
          return;
        }
        const result = applyEnd(toSnapshot(call), userId, new Date());
        if (!result.ok) {
          ack?.({ ok: false, error: result.error });
          return;
        }
        clearRingTimer(callId);
        applyMutation(call, result.mutation);
        await call.save();
        removeActiveCall(callId);

        const endedPayload = {
          callId,
          callerId: call.callerId,
          calleeId: call.calleeId,
          status: call.status,
          endedBy: userId,
          endedAt: call.endedAt,
          durationSec: call.durationSec,
        };
        messagingNamespace.to(`user:${call.callerId}`).emit("call:ended", endedPayload);
        messagingNamespace.to(`user:${call.calleeId}`).emit("call:ended", endedPayload);
        ack?.({ ok: true });
        logger.info(
          `[CallSignaling] ended call=${callId} status=${call.status} by=${userId} duration=${call.durationSec ?? 0}s`
        );
      } catch (err) {
        logger.error("[CallSignaling] call:end error", err);
        ack?.({ ok: false, error: "Failed to end call" });
      }
    });

    // --- call:signal (forward SDP / ICE) ---
    socket.on("call:signal", async (payload: CallSignalPayload, ack?: Ack) => {
      try {
        const { callId, to, payload: signalPayload } = payload || ({} as CallSignalPayload);
        if (!callId || !to) {
          ack?.({ ok: false, error: "Missing callId or to" });
          return;
        }
        const call = await loadCallForUser(callId, userId);
        if (!call) {
          ack?.({ ok: false, error: "Call not found" });
          return;
        }
        if (to !== call.callerId && to !== call.calleeId) {
          ack?.({ ok: false, error: "Invalid signaling target" });
          return;
        }
        if (to === userId) {
          ack?.({ ok: false, error: "Cannot signal self" });
          return;
        }
        messagingNamespace.to(`user:${to}`).emit("call:signal", {
          callId,
          from: userId,
          payload: signalPayload,
        });
        ack?.({ ok: true });
      } catch (err) {
        logger.error("[CallSignaling] call:signal error", err);
        ack?.({ ok: false, error: "Failed to forward signal" });
      }
    });

    // --- disconnect: end any live calls this socket was part of ---
    socket.on("disconnect", () => {
      if (deviceId !== undefined) {
        removeOnlineDevice(userId, deviceId);
      }
      void handleSocketDrop(messagingNamespace, userId);
    });
  });
}

/**
 * Ring-timeout handler: mark a still-ringing call as missed and notify both
 * parties. Pulled out of the closure so the (async) DB work isn't swallowed by
 * `setTimeout`. Idempotent — a call that already left `ringing` is a no-op.
 *
 * Exported so tests can exercise the exact missed-call path without driving the
 * 30s timer through fake clocks (which would also stall the async DB work).
 */
export async function handleRingTimeout(
  messagingNamespace: Namespace,
  callId: string
): Promise<void> {
  try {
    const fresh = await Call.findById(callId);
    if (!fresh) {
      removeActiveCall(callId);
      return;
    }
    const mutation = applyRingTimeout(toSnapshot(fresh), new Date());
    if (!mutation) {
      return;
    }
    applyMutation(fresh, mutation);
    await fresh.save();
    removeActiveCall(callId);
    const missedPayload = {
      callId,
      callerId: fresh.callerId,
      calleeId: fresh.calleeId,
      type: fresh.type,
    };
    messagingNamespace.to(`user:${fresh.callerId}`).emit("call:missed", missedPayload);
    messagingNamespace.to(`user:${fresh.calleeId}`).emit("call:missed", missedPayload);
  } catch (err) {
    logger.error("[CallSignaling] Ring timeout handler failed", err);
  }
}

/**
 * Socket-drop handler: when a user's socket disconnects, end any call of theirs
 * that was still SETTING UP (ringing/connecting) so the peer isn't left hanging.
 *
 * A CONNECTED call is deliberately left untouched: its media path is
 * peer-to-peer and survives a transient signaling-socket drop (Socket.IO
 * auto-reconnects). Real media loss on a connected call is detected by the
 * peers' own ICE-failure handling, which ends the call explicitly — the
 * signaling socket dropping is NOT evidence the media died. This mirrors the
 * frontend `onConnectionLost`, which also preserves connected calls; killing
 * them here would emit a spurious `call:ended` to the peer on every network
 * hiccup.
 */
async function handleSocketDrop(messagingNamespace: Namespace, userId: string): Promise<void> {
  const callIds = getUserCallIds(userId);
  if (callIds.length === 0) {
    return;
  }
  for (const callId of callIds) {
    const entry = getActiveCall(callId);
    if (!entry) continue;
    // Leave connected calls alone — only tear down calls that hadn't connected.
    if (entry.status === "connected") {
      continue;
    }
    try {
      const call = await Call.findById(callId);
      if (!call) {
        removeActiveCall(callId);
        continue;
      }
      // Re-check against the persisted doc: it may have connected between the
      // registry read and this fetch. A connected call must survive.
      if (call.status === "connected" || !!call.connectedAt) {
        updateActiveCallStatus(callId, "connected");
        continue;
      }
      const result = applyEnd(toSnapshot(call), userId, new Date());
      if (!result.ok) {
        continue;
      }
      clearRingTimer(callId);
      applyMutation(call, result.mutation);
      await call.save();
      removeActiveCall(callId);
      const endedPayload = {
        callId,
        callerId: call.callerId,
        calleeId: call.calleeId,
        status: call.status,
        endedBy: userId,
        endedAt: call.endedAt,
        durationSec: call.durationSec,
      };
      messagingNamespace.to(`user:${call.callerId}`).emit("call:ended", endedPayload);
      messagingNamespace.to(`user:${call.calleeId}`).emit("call:ended", endedPayload);
      logger.info(`[CallSignaling] ended unconnected call=${callId} on socket drop by=${userId}`);
    } catch (err) {
      logger.error("[CallSignaling] socket-drop cleanup failed", err);
    }
  }
}
