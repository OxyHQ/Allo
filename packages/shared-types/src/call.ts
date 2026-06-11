/**
 * Shared types for WebRTC 1:1 voice/video calls.
 */

export type CallType = "audio" | "video";

export type CallStatus =
  | "initiated"
  | "ringing"
  | "connected"
  | "completed"
  | "missed"
  | "declined"
  | "failed"
  | "canceled";

export type CallDirection = "incoming" | "outgoing";

export interface CallPeerSummary {
  id: string;
  name?: { first?: string; last?: string } | string;
  username?: string;
  handle?: string;
  avatar?: string;
}

export interface CallHistoryEntry {
  id: string;
  callerId: string;
  calleeId: string;
  conversationId?: string;
  type: CallType;
  status: CallStatus;
  startedAt: string | Date;
  connectedAt?: string | Date;
  endedAt?: string | Date;
  durationSec?: number;
  endedBy?: string;
  direction: CallDirection;
  peer: CallPeerSummary;
}

// --- Socket payloads ---

export interface CallInvitePayload {
  callId?: string;
  calleeId: string;
  type: CallType;
  conversationId?: string;
}

export interface CallIncomingEvent {
  callId: string;
  callerId: string;
  calleeId: string;
  type: CallType;
  conversationId?: string;
  startedAt: string | Date;
}

export interface CallAcceptedEvent {
  callId: string;
  callerId: string;
  calleeId: string;
  type: CallType;
  conversationId?: string;
  connectedAt: string | Date;
}

export interface CallDeclinedEvent {
  callId: string;
  callerId: string;
  calleeId: string;
  endedBy: string;
}

export interface CallCanceledEvent {
  callId: string;
  callerId: string;
  calleeId: string;
  endedBy: string;
}

export interface CallEndedEvent {
  callId: string;
  callerId: string;
  calleeId: string;
  status: CallStatus;
  endedBy: string;
  endedAt: string | Date;
  durationSec?: number;
}

export interface CallMissedEvent {
  callId: string;
  callerId: string;
  calleeId: string;
  type: CallType;
}

/**
 * Emitted to a callee's OTHER devices when one of their devices accepts a call,
 * so the siblings stop ringing. The accepting device id (when known) lets a
 * client self-dismiss even if the event reached it via the shared user room.
 */
export interface CallAnsweredElsewhereEvent {
  callId: string;
  calleeId: string;
  /** Device id that accepted, when the accepting client claimed one. */
  answeringDeviceId?: number;
}

export interface CallSignalPayload<T = unknown> {
  callId: string;
  /** Recipient userId (server forwards to user:<to> room). */
  to: string;
  payload: T;
}

export interface CallSignalEvent<T = unknown> {
  callId: string;
  from: string;
  payload: T;
}

/**
 * Wire payloads carried inside CallSignalPayload.payload.
 * The signaling channel itself is opaque, but these are the conventions
 * used between frontend peers.
 */
/**
 * Minimal structural type for ICE candidates. Mirrors the lib.dom
 * `RTCIceCandidateInit` so we don't need the DOM lib in shared-types.
 */
export interface CallIceCandidateInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export type CallSignalBody =
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: CallIceCandidateInit };
