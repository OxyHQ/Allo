/**
 * CALLS: what the server has to know, and nothing else.
 *
 * Signalling is not here. Offers, answers and ICE candidates travel as
 * encrypted `call` application messages inside the conversation, so the server
 * relays them without reading them. What it holds is the state machine it
 * cannot do without:
 *
 * - a call, so a ring can be forked to every device of the callee, cancelled
 *   on the ones that lost, and expired when nobody answers;
 * - a participant row per rung device, so "first to answer wins" has somewhere
 *   to be decided.
 *
 * WhatsApp's whitepaper says the same about its own server in almost the same
 * words. It is call metadata in a database, it is subpoenable, and
 * `threat-model.md` §5 says so.
 *
 * **The call LOG is not this.** What a person sees in their conversation is an
 * encrypted `call_log` message written when the call ends; these rows are
 * operational and are swept.
 */
import { z } from "zod";
import {
  accountIdSchema,
  conversationIdSchema,
  idSchema,
  idempotencyKeySchema,
  instanceIdSchema,
  isoDateSchema,
} from "./common";

/** Voice or video. A call that starts as voice may turn its camera on; the row keeps what it started as. */
export const CALL_MODES = ["voice", "video"] as const;
export const callModeSchema = z.enum(CALL_MODES);
export type CallMode = z.infer<typeof callModeSchema>;

/**
 * Where a call is.
 *
 * `ringing` is the only state with a deadline: nobody answering is a normal
 * ending, and it is the server that notices, because the caller may have gone
 * too.
 */
export const CALL_STATES = ["ringing", "active", "ended"] as const;
export const callStateSchema = z.enum(CALL_STATES);
export type CallState = z.infer<typeof callStateSchema>;

/**
 * Why it ended. These map onto what the platforms already model —
 * `CXCallEndedReason` on iOS, `DisconnectCause` on Android — because a call UI
 * that invents its own vocabulary has to translate it twice.
 */
export const CALL_END_REASONS = [
  "hangup",
  "declined",
  "missed",
  "busy",
  "cancelled",
  "failed",
  "answered_elsewhere",
  "declined_elsewhere",
] as const;
export const callEndReasonSchema = z.enum(CALL_END_REASONS);
export type CallEndReason = z.infer<typeof callEndReasonSchema>;

/** How long a ring lasts before the server calls it missed. */
export const CALL_RING_TIMEOUT_MS = 45_000;
/** How long an operational call row is kept after it ends, for the log to settle and for support to answer "did it ring". */
export const CALL_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Participants in one call. Beyond this the SFU is not the limit, the screen is. */
export const MAX_CALL_PARTICIPANTS = 32;

/** One rung device, and what became of it. */
export const callParticipantSchema = z.object({
  accountId: accountIdSchema,
  instanceId: instanceIdSchema,
  /** `ringing` until it answers, declines or the call ends without it. */
  state: z.enum(["ringing", "joined", "left", "declined", "missed"]),
  joinedAt: isoDateSchema.nullable(),
  leftAt: isoDateSchema.nullable(),
});
export type CallParticipant = z.infer<typeof callParticipantSchema>;

/**
 * A call, as any participant may see it.
 *
 * `relayed` is decided by the server from the participants' own privacy
 * settings and is told to everybody, because a client has to know whether to
 * offer its local candidates. WHO asked for it is not told: that would turn a
 * privacy setting into a broadcast.
 */
export const callSchema = z.object({
  id: idSchema,
  conversationId: conversationIdSchema,
  initiatorAccountId: accountIdSchema,
  initiatorInstanceId: instanceIdSchema,
  mode: callModeSchema,
  state: callStateSchema,
  /** True for a group call, and for a 1:1 where either side hides its address. */
  relayed: z.boolean(),
  /** More than two accounts: the media goes through the SFU. */
  group: z.boolean(),
  participants: z.array(callParticipantSchema).max(MAX_CALL_PARTICIPANTS),
  startedAt: isoDateSchema,
  answeredAt: isoDateSchema.nullable(),
  endedAt: isoDateSchema.nullable(),
  endReason: callEndReasonSchema.nullable(),
  /** When the ring gives up. Null once the call is answered or over. */
  ringExpiresAt: isoDateSchema.nullable(),
});
export type Call = z.infer<typeof callSchema>;

export const createCallRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  conversationId: conversationIdSchema,
  mode: callModeSchema,
});
export type CreateCallRequest = z.infer<typeof createCallRequestSchema>;

export const callResponseSchema = z.object({ call: callSchema });
export type CallResponse = z.infer<typeof callResponseSchema>;

export const endCallRequestSchema = z.object({
  /** What the caller believes happened. The server refuses one that contradicts the state it holds. */
  reason: z.enum(["hangup", "declined", "busy", "cancelled", "failed"]),
});
export type EndCallRequest = z.infer<typeof endCallRequestSchema>;

/**
 * A STUN and TURN server the client may use, with a credential that expires.
 *
 * The long-term credential mechanism of RFC 8489 §9.2, issued the way the
 * whole WebRTC ecosystem issues it — `username = "<expiry>:<account>"`,
 * `credential = base64(HMAC-SHA1(secret, username))`, from the 2013 REST draft
 * that never became an RFC and is what every TURN server implements. Short
 * TTLs, and the account is in the username so a relay's own logs and quotas
 * are per account rather than per process.
 */
export const iceServerSchema = z.object({
  urls: z.array(z.string().min(1).max(256)).min(1).max(8),
  username: z.string().max(256).optional(),
  credential: z.string().max(512).optional(),
});
export type IceServer = z.infer<typeof iceServerSchema>;

export const iceServersResponseSchema = z.object({
  iceServers: z.array(iceServerSchema).max(8),
  /** When these credentials stop working, so a client can refresh before a long call drops. */
  expiresAt: isoDateSchema,
  /**
   * Whether this client must offer ONLY relay candidates — `relay` in WebRTC's
   * `iceTransportPolicy`. True when this call is relayed, which is true when
   * anybody in it hides their address, and always true for a group.
   */
  relayOnly: z.boolean(),
});
export type IceServersResponse = z.infer<typeof iceServersResponseSchema>;

/** The SFU ticket for a group call: a LiveKit access token, and where to use it. */
export const callTokenResponseSchema = z.object({
  url: z.string().min(1).max(512),
  token: z.string().min(1).max(4096),
  room: z.string().min(1).max(128),
  expiresAt: isoDateSchema,
});
export type CallTokenResponse = z.infer<typeof callTokenResponseSchema>;

// ---- socket ----------------------------------------------------------------

/** Server → client, to a rung device: somebody is calling. The payload is metadata; the offer arrives encrypted, in the conversation. */
export const callIncomingEventSchema = z.object({
  callId: idSchema,
  conversationId: conversationIdSchema,
  initiatorAccountId: accountIdSchema,
  mode: callModeSchema,
  group: z.boolean(),
});
export type CallIncomingEvent = z.infer<typeof callIncomingEventSchema>;

/**
 * Server → client: the call changed. Sent to every device that was rung and to
 * the caller's, so the devices that lost a race stop ringing.
 */
export const callUpdatedEventSchema = z.object({
  callId: idSchema,
  state: callStateSchema,
  /** Which device answered, when that is what changed. */
  answeredByInstanceId: instanceIdSchema.nullable(),
  endReason: callEndReasonSchema.nullable(),
});
export type CallUpdatedEvent = z.infer<typeof callUpdatedEventSchema>;
