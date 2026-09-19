import { describe, expect, it } from "vitest";
import {
  CALL_END_REASONS,
  CALL_RING_TIMEOUT_MS,
  callSchema,
  createCallRequestSchema,
  iceServersResponseSchema,
  MAX_CALL_PARTICIPANTS,
} from "../calls";
import { appMessageSchema, decodeAppMessage, decodeAppMessageOrIgnore, encodeAppMessage, type AppMessage } from "../appMessage";
import { UUID_V7 } from "./fixtures";

const call = {
  id: UUID_V7,
  conversationId: UUID_V7,
  initiatorAccountId: UUID_V7,
  initiatorInstanceId: UUID_V7,
  mode: "voice" as const,
  state: "ringing" as const,
  relayed: false,
  group: false,
  participants: [
    { accountId: UUID_V7, instanceId: UUID_V7, state: "ringing" as const, joinedAt: null, leftAt: null },
  ],
  startedAt: "2026-09-19T10:00:00.000Z",
  answeredAt: null,
  endedAt: null,
  endReason: null,
  ringExpiresAt: "2026-09-19T10:00:45.000Z",
};

describe("callSchema", () => {
  it("takes a ringing call and an ended one", () => {
    expect(callSchema.safeParse(call).success).toBe(true);
    expect(
      callSchema.safeParse({
        ...call,
        state: "ended",
        endedAt: "2026-09-19T10:04:00.000Z",
        endReason: "hangup",
        ringExpiresAt: null,
      }).success,
    ).toBe(true);
  });

  it("refuses an end reason that is not one, and a participant list over the cap", () => {
    expect(callSchema.safeParse({ ...call, endReason: "rude" }).success).toBe(false);
    expect(
      callSchema.safeParse({
        ...call,
        participants: Array(MAX_CALL_PARTICIPANTS + 1).fill(call.participants[0]),
      }).success,
    ).toBe(false);
  });

  it("names the endings the platforms already model, including the two about another device", () => {
    expect(CALL_END_REASONS).toContain("answered_elsewhere");
    expect(CALL_END_REASONS).toContain("declined_elsewhere");
    expect(CALL_END_REASONS).toContain("missed");
  });

  it("rings for less than a minute: 45 s is long enough to pick up and short enough not to be a nuisance", () => {
    expect(CALL_RING_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
    expect(CALL_RING_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("createCallRequestSchema", () => {
  it("wants a conversation and a mode, and nothing about the media", () => {
    const parsed = createCallRequestSchema.parse({
      idempotencyKey: "call-1",
      conversationId: UUID_V7,
      mode: "video",
      sdp: "v=0...",
    });
    // The offer is not the server's business: it is dropped here.
    expect(Object.keys(parsed).sort()).toEqual(["conversationId", "idempotencyKey", "mode"]);
  });
});

describe("iceServersResponseSchema", () => {
  it("carries relay-only, which is what a privacy switch actually does", () => {
    expect(
      iceServersResponseSchema.safeParse({
        iceServers: [{ urls: ["turn:relay.example:3478"], username: "1700000000:acct", credential: "abc" }],
        expiresAt: "2026-09-19T10:00:00.000Z",
        relayOnly: true,
      }).success,
    ).toBe(true);
    expect(iceServersResponseSchema.safeParse({ iceServers: [], expiresAt: "2026-09-19T10:00:00.000Z" }).success).toBe(false);
  });
});

describe("the two call message kinds", () => {
  it("signalling is ignorable control: a client that does not know it drops it", () => {
    const signal: AppMessage = { v: 1, t: "call", ctl: true, callId: "call-1", kind: "ice", candidates: ["candidate:1 1 UDP"] };
    expect(appMessageSchema.safeParse(signal).success).toBe(true);
    const bytes = encodeAppMessage(signal);
    expect(decodeAppMessage(bytes)).toEqual(signal);
    // An older build has no `call` branch, so it meets the marker and ignores it.
    const asUnknown = new TextEncoder().encode(JSON.stringify({ v: 1, t: "call_v2", ctl: true, callId: "x" }));
    expect(decodeAppMessageOrIgnore(asUnknown)).toBeNull();
  });

  it("the log is CONTENT: an old client saying it cannot draw it is right", () => {
    const log: AppMessage = { v: 1, t: "call_log", callId: "call-1", mode: "voice", outcome: "answered", durationMs: 252_000 };
    expect(appMessageSchema.safeParse(log).success).toBe(true);
    expect(decodeAppMessage(encodeAppMessage(log))).toEqual(log);
    // It carries no `ctl`, so it is not silently dropped by a build that does
    // not know it — which is the whole distinction the marker draws.
    expect("ctl" in (log as Record<string, unknown>)).toBe(false);
  });

  it("refuses an outcome that is not one, and an over-long candidate batch", () => {
    expect(appMessageSchema.safeParse({ v: 1, t: "call_log", callId: "c", mode: "voice", outcome: "great" }).success).toBe(false);
    expect(
      appMessageSchema.safeParse({
        v: 1,
        t: "call",
        ctl: true,
        callId: "c",
        kind: "ice",
        candidates: Array(65).fill("candidate:1"),
      }).success,
    ).toBe(false);
  });
});
