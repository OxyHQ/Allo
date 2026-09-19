/**
 * Calls: forking a ring, deciding who won, and noticing when nobody answered.
 *
 * Everything about the MEDIA is somewhere else — the offer, the candidates and
 * the keys are encrypted messages in the conversation, and the server relays
 * them without reading them. What is here is the part a client cannot do:
 *
 * 1. **Who may ring whom.** A joined member of the conversation, and never
 *    across a block in either direction. A ring is the loudest thing this
 *    system can do to a device.
 * 2. **The fork.** Every active instance of every other member is rung, and
 *    exactly one of them wins — `claimAnswer` is an UPDATE guarded on the
 *    state, so a second device answering a hundred milliseconds later is told
 *    who did instead of joining a call nobody else is on.
 * 3. **Whether the media is relayed.** True for a group, and for a 1:1 where
 *    EITHER side has `privacy_relay_calls` on: a connection cannot be half
 *    relayed. Everyone is told the call IS relayed and nobody is told who
 *    asked, because that would make a privacy setting a broadcast.
 * 4. **The ring giving up.** Nobody answering is a normal ending, and the
 *    caller may be gone too, so the server is what notices.
 */

import {
  CALL_RETENTION_MS,
  CALL_RING_TIMEOUT_MS,
  MAX_CALL_PARTICIPANTS,
  type Call,
  type CallEndReason,
  type CallResponse,
  type CallTokenResponse,
  type CreateCallRequest,
  type IceServersResponse,
} from "@allo/shared-types";
import { getDb, type AlloDatabase } from "../../db";
import {
  claimAnswer,
  claimEnd,
  findCallById,
  findCallByIdempotencyKey,
  findParticipant,
  insertCall,
  insertParticipants,
  listParticipants,
  setParticipantState,
  settleRingingParticipants,
  type CallRow,
} from "../../db/platform/callRepository";
import { findMember, listMembers } from "../../db/platform/conversationRepository";
import { listActiveInstancesForAccounts } from "../../db/platform/instanceRepository";
import { blockedEitherWay } from "../../db/social/blockRepository";
import { relayCallsOf } from "../../db/social/userSettingsRepository";
import { getRealtime } from "../../runtime/realtime";
import { AlloHttpError, forbidden, notFound, validationFailed } from "../../utils/httpErrors";
import { uuidv7 } from "@oxy.so/db";
import { getIceConfig } from "../../config/iceRuntime";
import { callRoomName, type LiveKitConfig } from "../../config/livekit";
import { getLiveKitConfig } from "../../config/sfuRuntime";
import { mintTurnCredential, type IceConfig } from "../../config/turn";
import { toCall } from "./wire";

export interface CallCaller {
  instanceId: string;
  accountId: string;
}

export interface CallServiceDeps {
  db?: AlloDatabase;
  now?: () => Date;
}

export async function createCall(
  caller: CallCaller,
  request: CreateCallRequest,
  deps: CallServiceDeps = {},
): Promise<CallResponse> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();

  const replayed = await findCallByIdempotencyKey(caller.instanceId, request.idempotencyKey, db);
  if (replayed) return { call: await view(replayed, db) };

  const mine = await findMember(request.conversationId, caller.accountId, db);
  if (!mine || mine.state !== "joined") throw notFound("no such conversation");

  const members = (await listMembers(request.conversationId, db)).filter(
    (member) => member.state === "joined" && member.accountId !== caller.accountId,
  );
  const otherAccounts = [...new Set(members.map((member) => member.accountId))];
  if (otherAccounts.length === 0) throw validationFailed("nobody to call", { path: ["conversationId"] });

  // A block cuts a ring in both directions, like everything else.
  const blocked = await blockedEitherWay(db, caller.accountId, otherAccounts);
  const reachableAccounts = otherAccounts.filter((accountId) => !blocked.has(accountId));
  if (reachableAccounts.length === 0) throw forbidden("cannot call this conversation");

  const devices = (await listActiveInstancesForAccounts(reachableAccounts, db)).slice(0, MAX_CALL_PARTICIPANTS);
  if (devices.length === 0) throw validationFailed("nobody to ring", { path: ["conversationId"] });

  const group = reachableAccounts.length > 1;
  // Either side asking is enough, and the caller counts.
  const hiders = await relayCallsOf(db, [caller.accountId, ...reachableAccounts]);
  const relayed = group || hiders.size > 0;

  const id = uuidv7();
  const ringExpiresAt = new Date(now.getTime() + CALL_RING_TIMEOUT_MS);
  const expiresAt = new Date(now.getTime() + CALL_RETENTION_MS);

  const row = await db.transaction(async (tx) => {
    const call = await insertCall(
      {
        id,
        conversationId: request.conversationId,
        initiatorAccountId: caller.accountId,
        initiatorInstanceId: caller.instanceId,
        mode: request.mode,
        relayed,
        group,
        idempotencyKey: request.idempotencyKey,
        ringExpiresAt,
        expiresAt,
      },
      tx,
    );
    await insertParticipants(
      devices.map((device) => ({
        callId: call.id,
        accountId: device.accountId,
        instanceId: device.id,
        expiresAt,
      })),
      tx,
    );
    return call;
  });

  // After the commit, never inside it.
  const realtime = getRealtime();
  for (const device of devices) {
    realtime.callIncoming(device.id, {
      callId: row.id,
      conversationId: row.conversationId,
      initiatorAccountId: row.initiatorAccountId,
      mode: row.mode,
      group: row.group,
    });
  }
  return { call: await view(row, db) };
}

/**
 * This device picks up.
 *
 * The transition is claimed, not checked-then-written: two of somebody's
 * phones answering in the same breath is the normal case for a forked ring,
 * and exactly one of them has to win.
 */
export async function answerCall(caller: CallCaller, callId: string, deps: CallServiceDeps = {}): Promise<CallResponse> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();
  const participant = await findParticipant(callId, caller.instanceId, db);
  if (!participant) throw notFound("no such call");

  const claimed = await claimAnswer(callId, now, db);
  const call = claimed ?? (await requireCall(callId, db));
  if (!claimed) {
    // Somebody else got there first. Say so rather than pretending to join.
    const answeredBy = (await listParticipants(callId, db)).find((one) => one.state === "joined");
    throw forbidden(answeredBy?.instanceId === caller.instanceId ? "already answered here" : "answered elsewhere");
  }

  await setParticipantState(callId, caller.instanceId, "joined", now, db);
  // This account's OTHER phones stop ringing. In a group everybody else's keep
  // going — one person picking up is not the group answering.
  await settleRingingParticipants(callId, "left", now, db, {
    exceptInstanceId: caller.instanceId,
    onlyAccountId: caller.accountId,
  });

  announce(call, { answeredByInstanceId: caller.instanceId }, await audienceOf(call, db));
  return { call: await view(call, db) };
}

/** This device says no. In a 1:1 that ends the call; in a group it is one seat refusing. */
export async function declineCall(caller: CallCaller, callId: string, deps: CallServiceDeps = {}): Promise<CallResponse> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();
  const participant = await findParticipant(callId, caller.instanceId, db);
  if (!participant) throw notFound("no such call");

  await setParticipantState(callId, caller.instanceId, "declined", now, db);
  const participants = await listParticipants(callId, db);
  const stillRinging = participants.some((one) => one.state === "ringing");
  const anybodyJoined = participants.some((one) => one.state === "joined");

  if (!stillRinging && !anybodyJoined) {
    const ended = await claimEnd(callId, "declined", now, db);
    const call = ended ?? (await requireCall(callId, db));
    announce(call, {}, await audienceOf(call, db));
    return { call: await view(call, db) };
  }
  const call = await requireCall(callId, db);
  announce(call, {}, await audienceOf(call, db));
  return { call: await view(call, db) };
}

/** Hanging up, cancelling a ring, or reporting that the media never came up. */
export async function endCall(
  caller: CallCaller,
  callId: string,
  reason: Exclude<CallEndReason, "missed" | "answered_elsewhere" | "declined_elsewhere">,
  deps: CallServiceDeps = {},
): Promise<CallResponse> {
  const db = deps.db ?? getDb();
  const now = deps.now?.() ?? new Date();
  const existing = await requireCall(callId, db);
  const participant = await findParticipant(callId, caller.instanceId, db);
  if (existing.initiatorInstanceId !== caller.instanceId && !participant) throw notFound("no such call");

  const ended = await claimEnd(callId, reason, now, db);
  const call = ended ?? existing;
  if (ended) {
    await settleRingingParticipants(callId, reason === "cancelled" ? "missed" : "left", now, db);
    announce(call, {}, await audienceOf(call, db));
  }
  return { call: await view(call, db) };
}

export async function readCall(caller: CallCaller, callId: string, deps: CallServiceDeps = {}): Promise<CallResponse> {
  const db = deps.db ?? getDb();
  const call = await requireCall(callId, db);
  const participant = await findParticipant(callId, caller.instanceId, db);
  if (call.initiatorInstanceId !== caller.instanceId && !participant) throw notFound("no such call");
  return { call: await view(call, db) };
}

/**
 * Where this call's media may go.
 *
 * `relayOnly` is the call's own answer, not this caller's setting: either side
 * hiding its address makes the whole call relayed, and the other side has to
 * be told so it stops offering its own candidates. It is told THAT, never who
 * asked — a privacy setting that announces itself is not one.
 *
 * With no relay configured this answers STUN alone, which is honest: a direct
 * call still connects, and a call that needed a relay will fail rather than
 * quietly leak an address it was told not to.
 */
export async function callIceServers(
  caller: CallCaller,
  callId: string,
  deps: CallServiceDeps & { ice?: IceConfig; now?: () => Date } = {},
): Promise<IceServersResponse> {
  const { call } = await readCall(caller, callId, deps);
  const ice = deps.ice ?? getIceConfig();
  const now = deps.now?.() ?? new Date();

  const iceServers: IceServersResponse["iceServers"] = [{ urls: [...ice.stunUrls] }];
  let expiresAt = new Date(now.getTime() + 3_600_000);
  if (ice.turn) {
    const credential = mintTurnCredential(ice.turn, caller.accountId, now);
    iceServers.push({ urls: [...ice.turn.urls], username: credential.username, credential: credential.credential });
    expiresAt = credential.expiresAt;
  }
  return { iceServers, expiresAt: expiresAt.toISOString(), relayOnly: call.relayed };
}

/**
 * The SFU ticket for a GROUP call.
 *
 * Three refusals, and each is a rule rather than a guard:
 *
 * - **A 1:1 call has no ticket.** Its media is peer to peer, or through the
 *   TURN relay when somebody hides their address; the SFU is not in that path
 *   at all, and issuing a room for it would invent a third party the ADR
 *   deliberately kept out.
 * - **A call that is over has no ticket**, so a token cannot outlive the call
 *   it was minted for.
 * - **Only a device that has JOINED gets one.** A rung device that has not
 *   answered has not agreed to be in the room, and a ticket is how you get in.
 *   Answering first is the point of the state machine.
 *
 * `identity` is the INSTANCE, not the account: two of somebody's devices in
 * one call are two participants, and the per-sender frame key of Decision 1 is
 * per device. Data is not published — signalling and the frame keys travel as
 * encrypted messages in the conversation, never over LiveKit — so the grant
 * says so rather than leaving a channel open that nothing uses.
 */
export async function callSfuToken(
  caller: CallCaller,
  callId: string,
  deps: CallServiceDeps & { livekit?: LiveKitConfig | null; now?: () => Date } = {},
): Promise<CallTokenResponse> {
  const db = deps.db ?? getDb();
  const { call } = await readCall(caller, callId, deps);
  if (!call.group) throw validationFailed("a 1:1 call does not use the SFU", { callId });
  if (call.state === "ended") throw validationFailed("the call has ended", { callId });

  const participant = await findParticipant(callId, caller.instanceId, db);
  if (!participant || participant.state !== "joined") {
    throw forbidden("answer the call before asking for a place in the room");
  }

  const config = deps.livekit !== undefined ? deps.livekit : getLiveKitConfig();
  if (!config) throw new AlloHttpError("unavailable", "Group calling is not configured on this deployment");

  const now = deps.now?.() ?? new Date();
  const room = callRoomName(callId);
  const { AccessToken } = await import("livekit-server-sdk");
  const grant = new AccessToken(config.apiKey, config.apiSecret, {
    identity: caller.instanceId,
    ttl: config.ttlSeconds,
  });
  grant.addGrant({
    roomJoin: true,
    room,
    canPublish: true,
    canSubscribe: true,
    // Nothing rides LiveKit's data channel: the offer, the candidates and the
    // per-sender frame keys are encrypted messages in the conversation.
    canPublishData: false,
  });
  return {
    url: config.url,
    token: await grant.toJwt(),
    room,
    expiresAt: new Date(now.getTime() + config.ttlSeconds * 1000).toISOString(),
  };
}

// ---- the parts --------------------------------------------------------------

async function requireCall(callId: string, db: AlloDatabase): Promise<CallRow> {
  const row = await findCallById(callId, db);
  if (!row) throw notFound("no such call");
  return row;
}

async function view(row: CallRow, db: AlloDatabase): Promise<Call> {
  return toCall(row, await listParticipants(row.id, db));
}

/** Every device that should hear about a change: the rung ones and the caller's own. */
async function audienceOf(call: CallRow, db: AlloDatabase): Promise<string[]> {
  const participants = await listParticipants(call.id, db);
  return [...new Set([call.initiatorInstanceId, ...participants.map((one) => one.instanceId)])];
}

function announce(call: CallRow, extra: { answeredByInstanceId?: string }, audience: readonly string[]): void {
  const realtime = getRealtime();
  for (const instanceId of audience) {
    realtime.callUpdated(instanceId, {
      callId: call.id,
      state: call.state,
      answeredByInstanceId: extra.answeredByInstanceId ?? null,
      endReason: call.endReason ?? null,
    });
  }
}
