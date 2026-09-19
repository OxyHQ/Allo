/**
 * Calls: the fork, the race, the refusals and the ring that nobody answered.
 *
 * Nothing here is about media. What is tested is what only the server can do —
 * ring every device, let exactly one win, stop the losers, refuse a ring
 * across a block, and notice silence.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { callResponseSchema, callTokenResponseSchema, iceServersResponseSchema, CALL_RING_TIMEOUT_MS } from "@allo/shared-types";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db";
import { calls } from "../../db/schema/calls";
import { blockUser } from "../../db/social/blockRepository";
import { ensureUserSettings, updateUserSettings } from "../../db/social/userSettingsRepository";
import { runCallRingTick } from "../../workers/callRingWorker";
import { clearIceConfig, setIceConfig } from "../../config/iceRuntime";
import { callRoomName, readLiveKitConfig } from "../../config/livekit";
import { clearLiveKitConfig, setLiveKitConfig } from "../../config/sfuRuntime";
import {
  accountId,
  createPlatformHarness,
  dmBetween,
  expectParses,
  groupOfThree,
  TestInstance,
  USER_HEADER,
  type PlatformHarness,
} from "./harness";

let h: PlatformHarness;

beforeAll(async () => {
  h = await createPlatformHarness();
}, 180_000);

afterAll(async () => {
  clearIceConfig();
  await h?.drop();
});

beforeEach(() => {
  h.realtime.reset();
  clearIceConfig();
  clearLiveKitConfig();
});

let keys = 0;
const ring = (caller: TestInstance, conversationId: string, mode: "voice" | "video" = "voice") => {
  keys += 1;
  return caller.signed("post", "/v1/calls", { idempotencyKey: `call-${process.pid}-${keys}`, conversationId, mode });
};

describe("POST /v1/calls", () => {
  it("requires the instance signature; an Oxy session alone is 401", async () => {
    const { a } = await dmBetween(h.app);
    const response = await request(h.app).post("/v1/calls").set(USER_HEADER, a.accountId).send({});
    expect(response.status).toBe(401);
  });

  it("rings every active device of the callee, and none of the caller's own", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const second = await TestInstance.register(h.app, b.accountId);
    await b.approve(second);
    const mine = await TestInstance.register(h.app, a.accountId);
    await a.approve(mine);

    const response = await ring(a, conversationId);
    expect(response.status).toBe(201);
    const { call } = expectParses(callResponseSchema, response.body);
    expect(call.state).toBe("ringing");
    expect(call.group).toBe(false);
    expect(new Date(call.ringExpiresAt!).getTime() - new Date(call.startedAt).getTime()).toBeCloseTo(
      CALL_RING_TIMEOUT_MS,
      -3,
    );

    expect(h.realtime.callRings.map((one) => one.instanceId).sort()).toEqual([b.id, second.id].sort());
    expect(h.realtime.callRings.map((one) => one.instanceId)).not.toContain(mine.id);
  });

  it("refuses to ring across a block, in either direction", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    await blockUser(getDb(), { userId: b.accountId, blockedId: a.accountId });
    const response = await ring(a, conversationId);
    expect(response.status).toBe(403);
    expect(h.realtime.callRings).toEqual([]);
  });

  it("refuses a conversation this account is not in, and says only that it does not exist", async () => {
    const { conversationId } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("stranger"));
    expect((await ring(stranger, conversationId)).status).toBe(404);
  });

  it("replays one idempotency key as the same call", async () => {
    const { a, conversationId } = await dmBetween(h.app);
    const key = `call-replay-${Date.now()}`;
    const first = await a.signed("post", "/v1/calls", { idempotencyKey: key, conversationId, mode: "voice" });
    const second = await a.signed("post", "/v1/calls", { idempotencyKey: key, conversationId, mode: "voice" });
    expect(second.body.call.id).toBe(first.body.call.id);
  });

  it("relays the call when EITHER side hides its address, and tells both without saying who asked", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    await ensureUserSettings(getDb(), b.accountId);
    await updateUserSettings(getDb(), b.accountId, { privacyRelayCalls: true });

    const { call } = expectParses(callResponseSchema, (await ring(a, conversationId)).body);
    expect(call.relayed).toBe(true);
    // The call says it is relayed; nothing in it says whose setting did that.
    expect(JSON.stringify(call)).not.toContain("privacyRelayCalls");
  });

  it("is direct when nobody hides", async () => {
    const { a, conversationId } = await dmBetween(h.app);
    const { call } = expectParses(callResponseSchema, (await ring(a, conversationId)).body);
    expect(call.relayed).toBe(false);
  });
});

describe("answering", () => {
  it("lets exactly one device win, and stops that account's other phones", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const second = await TestInstance.register(h.app, b.accountId);
    await b.approve(second);
    const id = (await ring(a, conversationId)).body.call.id as string;

    const won = await b.signed("post", `/v1/calls/${id}/answer`);
    expect(won.status).toBe(200);
    const { call } = expectParses(callResponseSchema, won.body);
    expect(call.state).toBe("active");
    expect(call.participants.find((one) => one.instanceId === b.id)?.state).toBe("joined");
    expect(call.participants.find((one) => one.instanceId === second.id)?.state).toBe("left");

    // The loser is told who answered rather than joining a call nobody is on.
    const late = await second.signed("post", `/v1/calls/${id}/answer`);
    expect(late.status).toBe(403);
    expect(h.realtime.callUpdates.some((one) => one.instanceId === second.id && one.state === "active")).toBe(true);
  });

  it("refuses an answer from a device that was never rung", async () => {
    const { a, conversationId } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("nosy"));
    const id = (await ring(a, conversationId)).body.call.id as string;
    expect((await stranger.signed("post", `/v1/calls/${id}/answer`)).status).toBe(404);
  });
});

describe("ending", () => {
  it("declining a 1:1 ends the call for everybody", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const id = (await ring(a, conversationId)).body.call.id as string;

    const { call } = expectParses(callResponseSchema, (await b.signed("post", `/v1/calls/${id}/decline`)).body);
    expect(call.state).toBe("ended");
    expect(call.endReason).toBe("declined");
    expect(h.realtime.callUpdates.some((one) => one.instanceId === a.id && one.endReason === "declined")).toBe(true);
  });

  it("the caller can cancel a ring, once", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const id = (await ring(a, conversationId)).body.call.id as string;

    const first = await a.signed("post", `/v1/calls/${id}/end`, { reason: "cancelled" });
    expect(expectParses(callResponseSchema, first.body).call.endReason).toBe("cancelled");
    const rung = expectParses(callResponseSchema, first.body).call.participants.find((one) => one.instanceId === b.id);
    expect(rung?.state).toBe("missed");

    // A second end does not overwrite the first: the reason people saw stands.
    const second = await a.signed("post", `/v1/calls/${id}/end`, { reason: "hangup" });
    expect(expectParses(callResponseSchema, second.body).call.endReason).toBe("cancelled");
  });

  it("refuses an end from somebody who was neither the caller nor rung", async () => {
    const { a, conversationId } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("nosy"));
    const id = (await ring(a, conversationId)).body.call.id as string;
    expect((await stranger.signed("post", `/v1/calls/${id}/end`, { reason: "hangup" })).status).toBe(404);
  });
});

describe("the ring nobody answered", () => {
  it("is noticed by the server, once, and everybody is told", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const id = (await ring(a, conversationId)).body.call.id as string;
    await getDb()
      .update(calls)
      .set({ ringExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(calls.id, id));
    h.realtime.reset();

    const first = await runCallRingTick({ db: getDb() });
    expect(first.missed).toBe(1);
    expect(h.realtime.callUpdates.filter((one) => one.callId === id).map((one) => one.instanceId).sort()).toEqual(
      [a.id, b.id].sort(),
    );

    // A second sweep finds nothing: the claim is what owns the transition.
    const second = await runCallRingTick({ db: getDb() });
    expect(second.missed).toBe(0);

    const after = expectParses(callResponseSchema, (await a.signed("get", `/v1/calls/${id}`)).body).call;
    expect(after.endReason).toBe("missed");
    expect(after.participants.find((one) => one.instanceId === b.id)?.state).toBe("missed");
  });

  it("leaves an answered call alone", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const id = (await ring(a, conversationId)).body.call.id as string;
    await b.signed("post", `/v1/calls/${id}/answer`);
    expect((await runCallRingTick({ db: getDb() })).missed).toBe(0);
  });
});

describe("GET /v1/calls/:id/ice", () => {
  it("answers STUN alone when no relay is configured, and says the call is direct", async () => {
    const { a, conversationId } = await dmBetween(h.app);
    const id = (await ring(a, conversationId)).body.call.id as string;

    const answer = expectParses(iceServersResponseSchema, (await a.signed("get", `/v1/calls/${id}/ice`)).body);
    expect(answer.relayOnly).toBe(false);
    expect(answer.iceServers).toHaveLength(1);
    expect(answer.iceServers[0].urls[0]).toMatch(/^stun:/);
    expect(answer.iceServers[0].credential).toBeUndefined();
  });

  it("mints a short-lived relay credential naming the account, and demands relay-only when the call is relayed", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    await ensureUserSettings(getDb(), a.accountId);
    await updateUserSettings(getDb(), a.accountId, { privacyRelayCalls: true });
    setIceConfig({ stunUrls: ["stun:stun.example:3478"], turn: { urls: ["turns:relay.example:443"], secret: "s3cret", ttlSeconds: 600 } });

    const id = (await ring(a, conversationId)).body.call.id as string;
    const answer = expectParses(iceServersResponseSchema, (await b.signed("get", `/v1/calls/${id}/ice`)).body);

    expect(answer.relayOnly).toBe(true);
    const relay = answer.iceServers.find((one) => one.urls[0].startsWith("turns:"));
    // `<expiry>:<account>` — the account is in the username so the relay's own
    // quotas and logs are per account.
    expect(relay?.username).toMatch(new RegExp(String.raw`^\d+:${b.accountId}$`));
    expect(relay?.credential).toBeTruthy();
    expect(new Date(answer.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a call this device has nothing to do with", async () => {
    const { a, conversationId } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("nosy"));
    const id = (await ring(a, conversationId)).body.call.id as string;
    expect((await stranger.signed("get", `/v1/calls/${id}/ice`)).status).toBe(404);
  });
});

/**
 * The SFU ticket. A group call's media goes through LiveKit; a 1:1's does not,
 * and the refusals say which rule they are.
 */
describe("GET /v1/calls/:id/token", () => {
  const LIVEKIT = { url: "wss://livekit.test", apiKey: "APIkeytest", apiSecret: "secret-that-is-long-enough-for-hs256", ttlSeconds: 3600 };

  beforeEach(() => setLiveKitConfig(LIVEKIT));
  afterAll(() => clearLiveKitConfig());

  it("is refused for a 1:1 call, which never touches the SFU", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const { call } = expectParses(callResponseSchema, (await ring(a, conversationId)).body);
    await b.signed("post", `/v1/calls/${call.id}/answer`).expect(200);

    const response = await a.signed("get", `/v1/calls/${call.id}/token`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_failed");
  });

  it("is refused until this device has answered, and then issued", async () => {
    const { a, b, conversationId } = await groupOfThree(h.app);
    const { call } = expectParses(callResponseSchema, (await ring(a, conversationId)).body);
    expect(call.group).toBe(true);
    expect(call.relayed).toBe(true);

    // `b` was rung and has not answered: no place in the room yet.
    const tooEarly = await b.signed("get", `/v1/calls/${call.id}/token`);
    expect(tooEarly.status).toBe(403);

    await b.signed("post", `/v1/calls/${call.id}/answer`).expect(200);
    const issued = await b.signed("get", `/v1/calls/${call.id}/token`);
    expect(issued.status).toBe(200);
    const ticket = expectParses(callTokenResponseSchema, issued.body);
    expect(ticket.url).toBe(LIVEKIT.url);
    expect(ticket.room).toBe(callRoomName(call.id));

    // The identity in the token is this DEVICE, because a per-sender key is
    // per device, and the grant opens no data channel.
    const claims = JSON.parse(Buffer.from(ticket.token.split(".")[1], "base64url").toString());
    expect(claims.sub).toBe(b.id);
    expect(claims.video).toMatchObject({ roomJoin: true, room: callRoomName(call.id), canPublish: true, canSubscribe: true });
    expect(claims.video.canPublishData).toBe(false);
  });

  it("is refused once the call is over, so a ticket cannot outlive it", async () => {
    const { a, b, conversationId } = await groupOfThree(h.app);
    const { call } = expectParses(callResponseSchema, (await ring(a, conversationId)).body);
    await b.signed("post", `/v1/calls/${call.id}/answer`).expect(200);
    await b.signed("post", `/v1/calls/${call.id}/end`, { reason: "hangup" }).expect(200);

    const response = await b.signed("get", `/v1/calls/${call.id}/token`);
    expect(response.status).toBe(400);
  });

  it("says so plainly when no SFU is configured, rather than pretending", async () => {
    clearLiveKitConfig();
    const { a, b, conversationId } = await groupOfThree(h.app);
    const { call } = expectParses(callResponseSchema, (await ring(a, conversationId)).body);
    await b.signed("post", `/v1/calls/${call.id}/answer`).expect(200);

    const response = await b.signed("get", `/v1/calls/${call.id}/token`);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("unavailable");
  });

  it("reads the three variables together or not at all", () => {
    expect(readLiveKitConfig({} as NodeJS.ProcessEnv)).toBeNull();
    expect(() => readLiveKitConfig({ LIVEKIT_URL: "wss://x" } as NodeJS.ProcessEnv)).toThrow(/together or not at all/);
    expect(readLiveKitConfig({ LIVEKIT_URL: "wss://x", LIVEKIT_API_KEY: "k", LIVEKIT_API_SECRET: "s" } as NodeJS.ProcessEnv)).toEqual({
      url: "wss://x",
      apiKey: "k",
      apiSecret: "s",
      ttlSeconds: 3600,
    });
  });
});
