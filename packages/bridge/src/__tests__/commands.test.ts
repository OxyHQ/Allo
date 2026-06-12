import express from "express";
import request from "supertest";
import {
  FakeTelegramClient,
  FakeStringSession,
  FakeNewMessage,
  FakeEditedMessage,
  FakeDeletedMessage,
  FakeLogLevel,
  FakeApi,
  FakeFloodWaitError,
  fakeGetPeerId,
  fakeGetDisplayName,
} from "./__mocks__/gramjs";
import {
  signJson,
  TEST_BRIDGE_SECRET,
  TEST_SESSION_KEY,
} from "./helpers/fixtures";
import { FLOOD_WAIT_RETRYABLE_CAP_SECONDS } from "../config";
import { sendDeduplicator } from "../sendDedup";

/**
 * Mock gramjs ENTIRELY (no network, no real client). Every subpath the manager
 * imports is redirected to the hand-rolled doubles.
 */
jest.mock("telegram", () => ({
  TelegramClient: FakeTelegramClient,
  Api: FakeApi,
}));
jest.mock("telegram/sessions", () => ({ StringSession: FakeStringSession }));
jest.mock("telegram/events", () => ({ NewMessage: FakeNewMessage }));
jest.mock("telegram/events/EditedMessage", () => ({ EditedMessage: FakeEditedMessage }));
jest.mock("telegram/events/DeletedMessage", () => ({ DeletedMessage: FakeDeletedMessage }));
jest.mock("telegram/extensions/Logger", () => ({ LogLevel: FakeLogLevel }));
jest.mock("telegram/Utils", () => ({
  getPeerId: fakeGetPeerId,
  getDisplayName: fakeGetDisplayName,
}));

// Capture outbound events to Allo instead of doing real HTTP.
const postedEvents: unknown[] = [];
jest.mock("../alloClient", () => ({
  postEvent: jest.fn(async (event: unknown) => {
    postedEvents.push(event);
    return true;
  }),
  uploadMedia: jest.fn(async () => null),
}));

// Imported AFTER mocks so the mocked modules are used.
import { buildApp } from "../app";
import { TelegramManager } from "../telegram/manager";
import * as sessionStore from "../sessionStore";
import { outboundRateLimiter } from "../rateLimiter";

function makeApp(manager: TelegramManager): express.Express {
  return buildApp(manager);
}

/** A signed POST helper against the connector. */
function signedPost(app: express.Express, path: string, body: unknown) {
  const rawBody = JSON.stringify(body);
  const ts = String(Date.now());
  return request(app)
    .post(path)
    .set("x-bridge-timestamp", ts)
    .set("x-bridge-signature", signJson(ts, path, rawBody))
    .set("Content-Type", "application/json")
    .send(rawBody);
}

const baseCommand = {
  v: 1 as const,
  type: "send" as const,
  network: "telegram" as const,
  ownerUserId: "owner-1",
  externalChatId: "tg-chat-1",
  messageId: "allo-msg-1",
  text: "outbound hello",
};

describe("POST /commands — auth + admission + send_result", () => {
  const prevEnabled = process.env.BRIDGE_ENABLED;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  const prevSessionKey = process.env.BRIDGE_SESSION_KEY;
  const prevApiId = process.env.TELEGRAM_API_ID;
  const prevApiHash = process.env.TELEGRAM_API_HASH;
  const prevAlloUrl = process.env.ALLO_INTERNAL_URL;

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SESSION_KEY = TEST_SESSION_KEY;
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "abcdef";
    process.env.ALLO_INTERNAL_URL = "http://allo.test";
    postedEvents.length = 0;
    FakeTelegramClient.reset();
    outboundRateLimiter.reset("owner-1");
    sendDeduplicator.clear();
  });

  afterEach(() => {
    process.env.BRIDGE_ENABLED = prevEnabled;
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
    process.env.BRIDGE_SESSION_KEY = prevSessionKey;
    process.env.TELEGRAM_API_ID = prevApiId;
    process.env.TELEGRAM_API_HASH = prevApiHash;
    process.env.ALLO_INTERNAL_URL = prevAlloUrl;
    jest.clearAllMocks();
  });

  it("rejects a bad signature with 401", async () => {
    const manager = new TelegramManager();
    const app = makeApp(manager);
    const rawBody = JSON.stringify(baseCommand);
    const ts = String(Date.now());
    const res = await request(app)
      .post("/commands")
      .set("x-bridge-timestamp", ts)
      .set("x-bridge-signature", "deadbeef")
      .set("Content-Type", "application/json")
      .send(rawBody);
    expect(res.status).toBe(401);
  });

  it("rejects a signature for a different path with 401 (cross-endpoint replay)", async () => {
    const manager = new TelegramManager();
    const app = makeApp(manager);
    const rawBody = JSON.stringify(baseCommand);
    const ts = String(Date.now());
    const res = await request(app)
      .post("/commands")
      .set("x-bridge-timestamp", ts)
      .set("x-bridge-signature", signJson(ts, "/sessions/telegram/link", rawBody))
      .set("Content-Type", "application/json")
      .send(rawBody);
    expect(res.status).toBe(401);
  });

  it("accepts a correctly-signed send and returns 200 fast, then fires a send_result", async () => {
    // An active session so ensureConnected() yields a (fake) connected client.
    await sessionStore.saveActive("owner-1", "SESSION", { id: "1000", username: "me" });
    FakeTelegramClient.behavior.sendResultId = 4242;

    const manager = new TelegramManager();
    const app = makeApp(manager);
    const res = await signedPost(app, "/commands", baseCommand);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ accepted: true });

    // The background send fires asynchronously; wait a tick for it to settle.
    await new Promise((r) => setTimeout(r, 20));

    const sendResult = postedEvents.find(
      (e) => (e as { type?: string }).type === "send_result"
    ) as Record<string, unknown> | undefined;
    expect(sendResult).toBeDefined();
    expect(sendResult).toMatchObject({
      type: "send_result",
      network: "telegram",
      ownerUserId: "owner-1",
      messageId: "allo-msg-1",
      status: "sent",
      externalMessageId: "4242",
    });
  });

  it("fires a FAILED send_result when there is no active session", async () => {
    // No saved session -> ensureConnected returns null -> sendMessage throws.
    const manager = new TelegramManager();
    const app = makeApp(manager);
    const res = await signedPost(app, "/commands", baseCommand);
    expect(res.status).toBe(200); // admission still succeeds; failure is async

    await new Promise((r) => setTimeout(r, 20));
    const sendResult = postedEvents.find(
      (e) => (e as { type?: string }).type === "send_result"
    ) as Record<string, unknown> | undefined;
    expect(sendResult).toMatchObject({
      type: "send_result",
      status: "failed",
      messageId: "allo-msg-1",
    });
    expect((sendResult as { error?: string }).error).toBeTruthy();
  });

  it("returns 400 for a send with neither text nor media", async () => {
    const manager = new TelegramManager();
    const app = makeApp(manager);
    const res = await signedPost(app, "/commands", { ...baseCommand, text: "", media: [] });
    expect(res.status).toBe(400);
  });

  it("returns 503 + Retry-After (no send_result) on a SHORT FLOOD_WAIT (retryable)", async () => {
    await sessionStore.saveActive("owner-1", "SESSION", { id: "1000" });
    // A short flood within the retryable cap: the outbox should back off & resend.
    FakeTelegramClient.behavior.sendError = new FakeFloodWaitError(30);

    const manager = new TelegramManager();
    const app = makeApp(manager);
    const res = await signedPost(app, "/commands", baseCommand);

    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("30");
    // A retryable flood must NOT emit a terminal send_result (the send isn't done).
    const sendResult = postedEvents.find((e) => (e as { type?: string }).type === "send_result");
    expect(sendResult).toBeUndefined();
  });

  it("returns 200 + terminal failed send_result on a LONG FLOOD_WAIT (beyond cap)", async () => {
    await sessionStore.saveActive("owner-1", "SESSION", { id: "1000" });
    // A flood beyond the retryable cap: fail terminally rather than hold the row.
    FakeTelegramClient.behavior.sendError = new FakeFloodWaitError(
      FLOOD_WAIT_RETRYABLE_CAP_SECONDS + 60
    );

    const manager = new TelegramManager();
    const app = makeApp(manager);
    const res = await signedPost(app, "/commands", baseCommand);

    expect(res.status).toBe(200);
    const sendResult = postedEvents.find(
      (e) => (e as { type?: string }).type === "send_result"
    ) as Record<string, unknown> | undefined;
    expect(sendResult).toMatchObject({
      type: "send_result",
      status: "failed",
      messageId: "allo-msg-1",
    });
    expect((sendResult as { error?: string }).error).toContain("flood_wait_");
  });

  it("returns 429 once the per-account outbound cap is exceeded", async () => {
    await sessionStore.saveActive("owner-1", "SESSION", { id: "1000" });
    const manager = new TelegramManager();
    const app = makeApp(manager);

    // The cap is OUTBOUND_SENDS_PER_WINDOW (20). Exhaust it, then expect 429.
    let last = 0;
    for (let i = 0; i < 21; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await signedPost(app, "/commands", { ...baseCommand, messageId: `m-${i}` });
      last = res.status;
    }
    expect(last).toBe(429);
  });

  it("returns 503 telegram_not_configured for a session link when creds are absent", async () => {
    delete process.env.TELEGRAM_API_ID;
    delete process.env.TELEGRAM_API_HASH;
    const manager = new TelegramManager();
    const app = makeApp(manager);
    const res = await signedPost(app, "/sessions/telegram/link", { ownerUserId: "owner-1" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("telegram_not_configured");
  });
});

describe("POST /commands — messageId dedup (duplicate delivery / timeout-retry)", () => {
  const prevEnabled = process.env.BRIDGE_ENABLED;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  const prevSessionKey = process.env.BRIDGE_SESSION_KEY;
  const prevApiId = process.env.TELEGRAM_API_ID;
  const prevApiHash = process.env.TELEGRAM_API_HASH;
  const prevAlloUrl = process.env.ALLO_INTERNAL_URL;

  beforeEach(async () => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SESSION_KEY = TEST_SESSION_KEY;
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "abcdef";
    process.env.ALLO_INTERNAL_URL = "http://allo.test";
    postedEvents.length = 0;
    FakeTelegramClient.reset();
    outboundRateLimiter.reset("owner-1");
    sendDeduplicator.clear();
    await sessionStore.saveActive("owner-1", "SESSION", { id: "1000" });
  });

  afterEach(() => {
    process.env.BRIDGE_ENABLED = prevEnabled;
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
    process.env.BRIDGE_SESSION_KEY = prevSessionKey;
    process.env.TELEGRAM_API_ID = prevApiId;
    process.env.TELEGRAM_API_HASH = prevApiHash;
    process.env.ALLO_INTERNAL_URL = prevAlloUrl;
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it("sends exactly once when a duplicate arrives while the first send is in-flight", async () => {
    // Hold the first send open so the duplicate races it mid-flight.
    let releaseGate: () => void = () => undefined;
    FakeTelegramClient.sendGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const manager = new TelegramManager();
    const app = makeApp(manager);

    // First command: dispatch it NOW (supertest fires the request once `.then` is
    // attached) but don't await completion — it blocks inside sendMessage on the
    // gate. `Promise.resolve(...)` attaches a continuation, forcing the send.
    const firstPromise = Promise.resolve(signedPost(app, "/commands", baseCommand));

    // Wait until the first send has actually entered sendMessage (claim recorded).
    await waitFor(() => FakeTelegramClient.sendCount === 1);

    // Duplicate (same messageId) arrives while the first is in-flight.
    const dupRes = await signedPost(app, "/commands", baseCommand);
    expect(dupRes.status).toBe(200); // acknowledged as done, not re-sent
    // The duplicate must NOT have triggered a second Telegram send.
    expect(FakeTelegramClient.sendCount).toBe(1);

    // Release the gate; the original send completes normally.
    releaseGate();
    const firstRes = await firstPromise;
    expect(firstRes.status).toBe(200);

    // Still exactly one Telegram send overall, and exactly one send_result.
    expect(FakeTelegramClient.sendCount).toBe(1);
    const sendResults = postedEvents.filter((e) => (e as { type?: string }).type === "send_result");
    expect(sendResults).toHaveLength(1);
    expect(sendResults[0]).toMatchObject({ status: "sent", messageId: "allo-msg-1" });
  });

  it("suppresses a duplicate that arrives AFTER the first send already completed (within TTL)", async () => {
    const manager = new TelegramManager();
    const app = makeApp(manager);

    const first = await signedPost(app, "/commands", baseCommand);
    expect(first.status).toBe(200);
    expect(FakeTelegramClient.sendCount).toBe(1);

    // A timeout-retry of the same messageId arrives within the dedup TTL.
    const dup = await signedPost(app, "/commands", baseCommand);
    expect(dup.status).toBe(200);
    // No second Telegram send, and no second send_result.
    expect(FakeTelegramClient.sendCount).toBe(1);
    const sendResults = postedEvents.filter((e) => (e as { type?: string }).type === "send_result");
    expect(sendResults).toHaveLength(1);
  });

  it("allows a re-send once the dedup TTL has elapsed", async () => {
    // Drive the dedup clock via Date.now() (NOT fake timers, so express/IO are
    // untouched). The first send records `startedAt = T0`; advancing past the TTL
    // makes the same messageId claimable again.
    const t0 = 1_000_000_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);

    const manager = new TelegramManager();
    const app = makeApp(manager);

    const first = await signedPost(app, "/commands", baseCommand);
    expect(first.status).toBe(200);
    expect(FakeTelegramClient.sendCount).toBe(1);

    // Within TTL: duplicate is suppressed.
    const dupWithin = await signedPost(app, "/commands", baseCommand);
    expect(dupWithin.status).toBe(200);
    expect(FakeTelegramClient.sendCount).toBe(1);

    // Advance past the TTL (60s): the id is swept and a genuine re-send proceeds.
    nowSpy.mockReturnValue(t0 + 61_000);
    const afterTtl = await signedPost(app, "/commands", baseCommand);
    expect(afterTtl.status).toBe(200);
    expect(FakeTelegramClient.sendCount).toBe(2);
  });

  it("a short FLOOD_WAIT releases the messageId so the outbox retry can re-send", async () => {
    // First attempt floods (short, retryable) -> 503 and the id must be released.
    FakeTelegramClient.behavior.sendError = new FakeFloodWaitError(20);

    const manager = new TelegramManager();
    const app = makeApp(manager);

    const flooded = await signedPost(app, "/commands", baseCommand);
    expect(flooded.status).toBe(503);
    expect(FakeTelegramClient.sendCount).toBe(1);

    // The legitimate outbox retry of the SAME messageId must NOT be suppressed.
    FakeTelegramClient.behavior.sendError = undefined;
    const retry = await signedPost(app, "/commands", baseCommand);
    expect(retry.status).toBe(200);
    expect(FakeTelegramClient.sendCount).toBe(2);
  });

  it("does not dedup sends that omit a messageId (cannot correlate)", async () => {
    const manager = new TelegramManager();
    const app = makeApp(manager);
    const noId = { ...baseCommand, messageId: undefined };

    const a = await signedPost(app, "/commands", noId);
    const b = await signedPost(app, "/commands", noId);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Without a messageId there is nothing to dedup on -> both send.
    expect(FakeTelegramClient.sendCount).toBe(2);
  });
});

/** Poll a predicate until true or a small timeout, yielding to the event loop. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("GET /healthz — liveness (no auth)", () => {
  const prevEnabled = process.env.BRIDGE_ENABLED;
  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    FakeTelegramClient.reset();
  });
  afterEach(() => {
    process.env.BRIDGE_ENABLED = prevEnabled;
  });

  it("returns 200 without authentication", async () => {
    const manager = new TelegramManager();
    const app = buildApp(manager);
    const res = await request(app).get("/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});
