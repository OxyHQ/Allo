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
  fakeGetPeerId,
  fakeGetDisplayName,
} from "./__mocks__/gramjs";
import { signJson, TEST_BRIDGE_SECRET, TEST_SESSION_KEY } from "./helpers/fixtures";

jest.mock("telegram", () => ({ TelegramClient: FakeTelegramClient, Api: FakeApi }));
jest.mock("telegram/sessions", () => ({ StringSession: FakeStringSession }));
jest.mock("telegram/events", () => ({ NewMessage: FakeNewMessage }));
jest.mock("telegram/events/EditedMessage", () => ({ EditedMessage: FakeEditedMessage }));
jest.mock("telegram/events/DeletedMessage", () => ({ DeletedMessage: FakeDeletedMessage }));
jest.mock("telegram/extensions/Logger", () => ({ LogLevel: FakeLogLevel }));
jest.mock("telegram/Utils", () => ({ getPeerId: fakeGetPeerId, getDisplayName: fakeGetDisplayName }));

const postedEvents: unknown[] = [];
jest.mock("../alloClient", () => ({
  postEvent: jest.fn(async (event: unknown) => {
    postedEvents.push(event);
    return true;
  }),
  uploadMedia: jest.fn(async () => null),
}));

import { buildApp } from "../app";
import { TelegramManager } from "../telegram/manager";

/**
 * Link-flow contract: every link endpoint must return the canonical
 * `BridgeLinkStepResult` ({v:1, status, loginUrl?, externalSelf?, error?}), and a
 * successful login must push a `session_status: active` event carrying externalSelf.
 */
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

function lastSessionStatus(): Record<string, unknown> | undefined {
  const matches = postedEvents.filter(
    (e) => (e as { type?: string }).type === "session_status"
  ) as Record<string, unknown>[];
  return matches[matches.length - 1];
}

describe("link flow — canonical BridgeLinkStepResult", () => {
  const prev = {
    enabled: process.env.BRIDGE_ENABLED,
    secret: process.env.BRIDGE_SHARED_SECRET,
    sessionKey: process.env.BRIDGE_SESSION_KEY,
    apiId: process.env.TELEGRAM_API_ID,
    apiHash: process.env.TELEGRAM_API_HASH,
    alloUrl: process.env.ALLO_INTERNAL_URL,
  };

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SESSION_KEY = TEST_SESSION_KEY;
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "abcdef";
    process.env.ALLO_INTERNAL_URL = "http://allo.test";
    postedEvents.length = 0;
    FakeTelegramClient.reset();
  });

  afterEach(() => {
    process.env.BRIDGE_ENABLED = prev.enabled;
    process.env.BRIDGE_SHARED_SECRET = prev.secret;
    process.env.BRIDGE_SESSION_KEY = prev.sessionKey;
    process.env.TELEGRAM_API_ID = prev.apiId;
    process.env.TELEGRAM_API_HASH = prev.apiHash;
    process.env.ALLO_INTERNAL_URL = prev.alloUrl;
    jest.clearAllMocks();
  });

  it("QR link (no phoneNumber) returns {v:1, status:'pending', loginUrl}", async () => {
    FakeTelegramClient.qrBehavior = "hang"; // URL issued, awaiting scan
    const app = buildApp(new TelegramManager());
    const res = await signedPost(app, "/sessions/telegram/link", { ownerUserId: "owner-1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ v: 1, status: "pending" });
    expect(typeof res.body.loginUrl).toBe("string");
    expect(res.body.loginUrl).toMatch(/^tg:\/\/login\?token=/);
    // No qrUrl alias — the field is canonically `loginUrl`.
    expect(res.body.qrUrl).toBeUndefined();
  });

  it("phone link (phoneNumber present) returns {v:1, status:'needs_code'}", async () => {
    const app = buildApp(new TelegramManager());
    const res = await signedPost(app, "/sessions/telegram/link", {
      ownerUserId: "owner-1",
      phoneNumber: "+34600111122",
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ v: 1, status: "needs_code" });
  });

  it("phone code-accepted (no 2FA) returns {v:1, status:'active', externalSelf} and emits session_status active", async () => {
    FakeTelegramClient.phoneBehavior = "success";
    const manager = new TelegramManager();
    const app = buildApp(manager);

    const start = await signedPost(app, "/sessions/telegram/link", {
      ownerUserId: "owner-1",
      phoneNumber: "+34600111122",
    });
    expect(start.body.status).toBe("needs_code");

    const codeRes = await signedPost(app, "/sessions/telegram/link/code", {
      ownerUserId: "owner-1",
      code: "12345",
    });
    expect(codeRes.status).toBe(200);
    expect(codeRes.body).toMatchObject({
      v: 1,
      status: "active",
      externalSelf: { externalId: "1000", username: "me", displayName: "Me" },
    });
    // Phone hint is masked (raw phone never on the wire).
    expect(codeRes.body.externalSelf.phoneHint).toMatch(/•/);
    expect(codeRes.body.externalSelf.phone).toBeUndefined();

    // session_status active event carries externalSelf for the backend to persist.
    const status = lastSessionStatus();
    expect(status).toMatchObject({
      type: "session_status",
      sessionStatus: "active",
      externalSelf: { externalId: "1000" },
    });
  });

  it("phone code-accepted requiring 2FA returns {v:1, status:'needs_password'}, then password-accepted returns active", async () => {
    FakeTelegramClient.phoneBehavior = "needs_password";
    const manager = new TelegramManager();
    const app = buildApp(manager);

    await signedPost(app, "/sessions/telegram/link", {
      ownerUserId: "owner-1",
      phoneNumber: "+34600111122",
    });

    const codeRes = await signedPost(app, "/sessions/telegram/link/code", {
      ownerUserId: "owner-1",
      code: "12345",
    });
    expect(codeRes.body).toMatchObject({ v: 1, status: "needs_password" });

    const pwRes = await signedPost(app, "/sessions/telegram/link/password", {
      ownerUserId: "owner-1",
      password: "cloud-pw",
    });
    expect(pwRes.status).toBe(200);
    expect(pwRes.body).toMatchObject({
      v: 1,
      status: "active",
      externalSelf: { externalId: "1000" },
    });

    const status = lastSessionStatus();
    expect(status).toMatchObject({ sessionStatus: "active", externalSelf: { externalId: "1000" } });
  });

  it("phone code rejected returns {v:1, status:'error'} and emits session_status error", async () => {
    FakeTelegramClient.phoneBehavior = "fail_code";
    const manager = new TelegramManager();
    const app = buildApp(manager);

    await signedPost(app, "/sessions/telegram/link", {
      ownerUserId: "owner-1",
      phoneNumber: "+34600111122",
    });

    const codeRes = await signedPost(app, "/sessions/telegram/link/code", {
      ownerUserId: "owner-1",
      code: "00000",
    });
    expect(codeRes.status).toBe(200);
    expect(codeRes.body).toMatchObject({ v: 1, status: "error" });
    expect(typeof codeRes.body.error).toBe("string");

    const status = lastSessionStatus();
    expect(status).toMatchObject({ sessionStatus: "error" });
  });

  it("submitting a code with no pending login returns {v:1, status:'pending'}", async () => {
    const app = buildApp(new TelegramManager());
    const res = await signedPost(app, "/sessions/telegram/link/code", {
      ownerUserId: "nobody",
      code: "123",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ v: 1, status: "pending" });
  });

  it("logout emits session_status revoked (no externalSelf)", async () => {
    FakeTelegramClient.phoneBehavior = "success";
    const manager = new TelegramManager();
    const app = buildApp(manager);

    await signedPost(app, "/sessions/telegram/link", {
      ownerUserId: "owner-1",
      phoneNumber: "+34600111122",
    });
    await signedPost(app, "/sessions/telegram/link/code", { ownerUserId: "owner-1", code: "1" });
    postedEvents.length = 0;

    const res = await signedPost(app, "/sessions/telegram/logout", { ownerUserId: "owner-1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "revoked" });

    const status = lastSessionStatus();
    expect(status).toMatchObject({ sessionStatus: "revoked" });
    expect((status as { externalSelf?: unknown }).externalSelf).toBeUndefined();
  });
});
