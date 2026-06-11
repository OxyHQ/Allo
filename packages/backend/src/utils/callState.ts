/**
 * Pure call-lifecycle state machine for 1:1 WebRTC calls.
 *
 * Extracted from the Socket.IO handler so the transition rules (which status a
 * call moves to, which timestamps are stamped, who may perform an action) can be
 * unit-tested without booting Express / Socket.IO — mirroring the pattern used
 * by `deviceHandshake.ts` and `p2pSignaling.ts`.
 *
 * The functions here NEVER touch Mongoose, sockets or the clock directly: the
 * caller passes the current call fields and the `now` timestamp, and gets back
 * the fields to persist plus the wire payload to emit. This keeps every rule
 * deterministic and side-effect free.
 */

import type { CallStatus, CallType } from "../models/Call";

/** Status values that represent a finished call (no further transitions). */
export const TERMINAL_STATUSES: ReadonlySet<CallStatus> = new Set<CallStatus>([
  "completed",
  "missed",
  "declined",
  "failed",
  "canceled",
]);

/** Status values from which a callee may still accept. */
export const ACCEPTABLE_STATUSES: ReadonlySet<CallStatus> = new Set<CallStatus>([
  "ringing",
  "initiated",
]);

/**
 * Server-side timeout (ms) before an unanswered call is marked as missed.
 * 30 seconds matches typical mobile call timeouts (WhatsApp/Telegram).
 */
export const RING_TIMEOUT_MS = 30_000;

/** Minimal view of a persisted call that the state machine reasons about. */
export interface CallSnapshot {
  callerId: string;
  calleeId: string;
  status: CallStatus;
  type: CallType;
  conversationId?: string;
  startedAt: Date;
  connectedAt?: Date;
}

/** The set of fields a successful transition writes back to the call doc. */
export interface CallMutation {
  status?: CallStatus;
  connectedAt?: Date;
  endedAt?: Date;
  durationSec?: number;
  endedBy?: string;
}

/**
 * Result of attempting a lifecycle transition.
 *
 * Modeled as a single interface with optional fields (rather than a discriminated
 * union) to match this package's non-strict tsconfig (`strictNullChecks: false`),
 * under which union narrowing on a boolean discriminant does not apply — the same
 * shape used by `DeviceHandshakeResult`. On success `ok` is true and `mutation`
 * holds the fields to persist; on failure `ok` is false and `error` is set.
 */
export interface TransitionResult {
  ok: boolean;
  /** Fields to persist on the call document (only when `ok`). */
  mutation?: CallMutation;
  /** Machine-readable rejection reason (only when not `ok`). */
  error?: string;
}

function isTerminal(status: CallStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/**
 * Accept: only the callee may accept, and only from a non-terminal ringing call.
 * Idempotent on an already-connected call (returns ok with no mutation) so a
 * duplicate accept from a flaky client doesn't error.
 */
export function applyAccept(
  call: CallSnapshot,
  actorId: string,
  now: Date
): TransitionResult {
  if (actorId !== call.calleeId) {
    return { ok: false, error: "Only callee can accept" };
  }
  if (call.status === "connected") {
    // Already connected (e.g. accepted from this very device a moment ago).
    return { ok: true, mutation: {} };
  }
  if (!ACCEPTABLE_STATUSES.has(call.status)) {
    return { ok: false, error: `Cannot accept call in status ${call.status}` };
  }
  return { ok: true, mutation: { status: "connected", connectedAt: now } };
}

/**
 * Decline: only the callee may decline, only before the call connects. On an
 * already-terminal call we return ok with no mutation (idempotent) so a late
 * decline racing a cancel/timeout doesn't surface a spurious error.
 */
export function applyDecline(
  call: CallSnapshot,
  actorId: string,
  now: Date
): TransitionResult {
  if (actorId !== call.calleeId) {
    return { ok: false, error: "Only callee can decline" };
  }
  if (isTerminal(call.status)) {
    return { ok: true, mutation: {} };
  }
  if (call.status === "connected") {
    return { ok: false, error: "Use call:end for connected calls" };
  }
  return { ok: true, mutation: { status: "declined", endedAt: now, endedBy: actorId } };
}

/**
 * Cancel: only the caller may cancel, and only before the call connects (use
 * `applyEnd` once connected). Idempotent on an already-terminal call.
 */
export function applyCancel(
  call: CallSnapshot,
  actorId: string,
  now: Date
): TransitionResult {
  if (actorId !== call.callerId) {
    return { ok: false, error: "Only caller can cancel" };
  }
  if (isTerminal(call.status)) {
    return { ok: true, mutation: {} };
  }
  if (call.status === "connected") {
    return { ok: false, error: "Use call:end for connected calls" };
  }
  return { ok: true, mutation: { status: "canceled", endedAt: now, endedBy: actorId } };
}

/**
 * End: either participant may end. A connected call becomes `completed` with a
 * computed duration; ending before pickup is treated as canceled (by caller) or
 * declined (by callee). Idempotent on an already-terminal call.
 */
export function applyEnd(
  call: CallSnapshot,
  actorId: string,
  now: Date
): TransitionResult {
  if (actorId !== call.callerId && actorId !== call.calleeId) {
    return { ok: false, error: "Not a participant" };
  }
  if (isTerminal(call.status)) {
    return { ok: true, mutation: {} };
  }

  const wasConnected = call.status === "connected" || !!call.connectedAt;
  if (wasConnected) {
    const mutation: CallMutation = { status: "completed", endedAt: now, endedBy: actorId };
    if (call.connectedAt) {
      mutation.durationSec = Math.max(
        0,
        Math.round((now.getTime() - call.connectedAt.getTime()) / 1000)
      );
    }
    return { ok: true, mutation };
  }

  // Ending before pickup: caller → canceled, callee → declined.
  const status: CallStatus = actorId === call.callerId ? "canceled" : "declined";
  return { ok: true, mutation: { status, endedAt: now, endedBy: actorId } };
}

/**
 * Ring timeout: a call still ringing when the timer fires becomes `missed`.
 * Returns null when the call already left the ringing state (nothing to do).
 */
export function applyRingTimeout(call: CallSnapshot, now: Date): CallMutation | null {
  if (call.status !== "ringing" && call.status !== "initiated") {
    return null;
  }
  return { status: "missed", endedAt: now };
}

/**
 * Decide whether an inbound invite must be auto-declined because the callee is
 * already busy on another call. Pure so the busy rule is unit-testable.
 *
 * @param calleeHasActiveCall  Whether the callee currently has a connected or
 *   ringing call (tracked by the active-call registry).
 */
export function shouldAutoDeclineBusy(calleeHasActiveCall: boolean): boolean {
  return calleeHasActiveCall;
}

/**
 * Resolve the device rooms that must receive `call:answered-elsewhere` when the
 * callee accepts from one device, so the callee's OTHER ringing devices stop
 * ringing. We emit to each of the callee's known device rooms EXCEPT the one
 * that accepted. The accepting device is identified by `answeringDeviceId`.
 *
 * Returns the list of room names to target. When the accepting device id is
 * unknown (legacy client with no device id) we cannot exclude it by room, so we
 * return an empty list and rely on the payload-based self-dismiss (clients
 * compare `answeringDeviceId` and ignore their own).
 *
 * @param calleeId            The callee user id.
 * @param calleeDeviceIds     All device ids currently associated with the callee.
 * @param answeringDeviceId   The device id that accepted, if known.
 */
export function resolveAnsweredElsewhereRooms(
  calleeId: string,
  calleeDeviceIds: readonly number[],
  answeringDeviceId: number | undefined
): string[] {
  if (answeringDeviceId === undefined) {
    return [];
  }
  return calleeDeviceIds
    .filter((deviceId) => deviceId !== answeringDeviceId)
    .map((deviceId) => `device:${calleeId}:${deviceId}`);
}
