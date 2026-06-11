/**
 * In-memory registry of live calls, used by the call-signaling handler for
 * three things the persisted Call doc can't answer cheaply:
 *
 *  1. **Busy detection** — is a user already ringing/connected on another call?
 *     (so a fresh invite can be auto-declined instead of stacking calls).
 *  2. **Socket-drop cleanup** — which calls is a disconnecting socket part of?
 *     (so dropping mid-call ends the call for the peer instead of hanging).
 *  3. **Device targeting** — which device ids of a user are currently online?
 *     (so accept can stop the OTHER ringing devices precisely).
 *
 * Per-process and therefore single-instance only. With a single Fargate task
 * this is sufficient; horizontal scaling would move this to a shared store
 * (Redis), exactly like the `lastSeenWrites` throttle in server.ts. The
 * persisted Call document remains the source of truth for status/history — this
 * registry only accelerates the live-routing decisions above.
 */

import type { CallStatus } from "../models/Call";

/** A live call's participants and current status. */
interface ActiveCallEntry {
  callId: string;
  callerId: string;
  calleeId: string;
  status: CallStatus;
}

/** Per-user set of call ids the user is currently a participant in. */
const callsByUser = new Map<string, Set<string>>();
/** Call id → entry. */
const activeCalls = new Map<string, ActiveCallEntry>();
/**
 * Online device ids per user → reference count of live sockets for that device.
 * A device is "online" while at least one socket claims it. We reference-count
 * because a single client legitimately holds MULTIPLE sockets on the same
 * device (e.g. the realtime-messaging socket AND the call-signaling socket both
 * carry the same `deviceId`): removing on the first disconnect would wrongly
 * mark the device offline while the other socket is still live. A user with no
 * device id (legacy client) contributes nothing here.
 */
const deviceRefCountByUser = new Map<string, Map<number, number>>();

function addToUser(userId: string, callId: string): void {
  let set = callsByUser.get(userId);
  if (!set) {
    set = new Set();
    callsByUser.set(userId, set);
  }
  set.add(callId);
}

function removeFromUser(userId: string, callId: string): void {
  const set = callsByUser.get(userId);
  if (!set) return;
  set.delete(callId);
  if (set.size === 0) {
    callsByUser.delete(userId);
  }
}

/**
 * Register a call as live between two users. Idempotent: re-registering the same
 * call id updates its status.
 */
export function registerActiveCall(
  callId: string,
  callerId: string,
  calleeId: string,
  status: CallStatus
): void {
  activeCalls.set(callId, { callId, callerId, calleeId, status });
  addToUser(callerId, callId);
  addToUser(calleeId, callId);
}

/** Update the cached status of a live call (no-op if it's not tracked). */
export function updateActiveCallStatus(callId: string, status: CallStatus): void {
  const entry = activeCalls.get(callId);
  if (entry) {
    entry.status = status;
  }
}

/** Remove a call from the live registry (call ended/declined/canceled/missed). */
export function removeActiveCall(callId: string): void {
  const entry = activeCalls.get(callId);
  if (!entry) return;
  removeFromUser(entry.callerId, callId);
  removeFromUser(entry.calleeId, callId);
  activeCalls.delete(callId);
}

/**
 * Whether a user is busy: they have at least one call that is ringing or
 * connected. (Terminal calls are removed from the registry, so any tracked call
 * means an in-flight one — but we still guard on status for safety.)
 */
export function isUserBusy(userId: string): boolean {
  const set = callsByUser.get(userId);
  if (!set || set.size === 0) return false;
  for (const callId of set) {
    const entry = activeCalls.get(callId);
    if (entry && (entry.status === "ringing" || entry.status === "connected")) {
      return true;
    }
  }
  return false;
}

/** Every live call id a user currently participates in. */
export function getUserCallIds(userId: string): string[] {
  const set = callsByUser.get(userId);
  return set ? Array.from(set) : [];
}

/** Look up a live call entry (or undefined when not tracked). */
export function getActiveCall(callId: string): Readonly<ActiveCallEntry> | undefined {
  return activeCalls.get(callId);
}

// --- Online device tracking (reference-counted per socket) ---

/** Record that a socket for (userId, deviceId) connected. */
export function addOnlineDevice(userId: string, deviceId: number): void {
  let counts = deviceRefCountByUser.get(userId);
  if (!counts) {
    counts = new Map();
    deviceRefCountByUser.set(userId, counts);
  }
  counts.set(deviceId, (counts.get(deviceId) ?? 0) + 1);
}

/**
 * Record that a socket for (userId, deviceId) disconnected. The device is only
 * dropped from the online set once its last socket goes away.
 */
export function removeOnlineDevice(userId: string, deviceId: number): void {
  const counts = deviceRefCountByUser.get(userId);
  if (!counts) return;
  const next = (counts.get(deviceId) ?? 0) - 1;
  if (next > 0) {
    counts.set(deviceId, next);
    return;
  }
  counts.delete(deviceId);
  if (counts.size === 0) {
    deviceRefCountByUser.delete(userId);
  }
}

/** The device ids of a user with at least one live socket. */
export function getOnlineDeviceIds(userId: string): number[] {
  const counts = deviceRefCountByUser.get(userId);
  return counts ? Array.from(counts.keys()) : [];
}

/**
 * Reset all registry state. Test-only helper so suites don't leak live calls
 * into one another.
 */
export function __resetCallRegistryForTests(): void {
  callsByUser.clear();
  activeCalls.clear();
  deviceRefCountByUser.clear();
}
