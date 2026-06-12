import express from "express";
import request from "supertest";
import { captureRawBody } from "../middleware/bridgeAuth";
import internalBridgeRouter from "../routes/internalBridge";
import {
  BRIDGE_TIMESTAMP_HEADER,
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_TIMESTAMP_TOLERANCE_MS,
  BRIDGE_EVENTS_PATH,
} from "../config/bridge";
import { installMockMessaging, type MockMessaging } from "./helpers/mockSocket";
import {
  TEST_BRIDGE_SECRET,
  TEST_BRIDGE_SECRET_TOO_SHORT,
  signEvents,
} from "./helpers/bridgeFixtures";
import Conversation from "../models/Conversation";
import Message from "../models/Message";
import LinkedAccount from "../models/LinkedAccount";

/**
 * Mirror the REAL server mount: the scoped raw-body json parser runs first (so
 * `/events` gets `req.rawBody`), then the router applies `bridgeAuth` PER ROUTE.
 * The blanket `bridgeAuth` mount middleware was removed (Finding 1).
 */
function buildBridgeApp() {
  const app = express();
  app.use("/internal/bridge", express.json({ verify: captureRawBody }), internalBridgeRouter);
  return app;
}

const validMessageEvent = {
  v: 1,
  type: "message",
  network: "telegram",
  ownerUserId: "owner-1",
  externalChatId: "tg-123",
  externalSenderId: "tg-123",
  externalMessageId: "tg-msg-1",
  text: "hello from telegram",
};

describe("bridgeAuth middleware (HMAC)", () => {
  let mock: MockMessaging;
  const prevEnabled = process.env.BRIDGE_ENABLED;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  const prevUrl = process.env.BRIDGE_SERVICE_URL;

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SERVICE_URL = "http://bridge.test";
    mock = installMockMessaging();
    jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
  });

  afterEach(() => {
    mock.restore();
    jest.restoreAllMocks();
    process.env.BRIDGE_ENABLED = prevEnabled;
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
    process.env.BRIDGE_SERVICE_URL = prevUrl;
  });

  it("accepts a request with a fresh timestamp and correct signature (and runs the router)", async () => {
    // Finding 3 gate: a 'message' event requires an ACTIVE linked account.
    await LinkedAccount.create({ userId: "owner-1", network: "telegram", status: "active" });
    const app = buildBridgeApp();
    const rawBody = JSON.stringify(validMessageEvent);
    const ts = String(Date.now());
    const res = await request(app)
      .post("/internal/bridge/events")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .set(BRIDGE_SIGNATURE_HEADER, signEvents(ts, rawBody))
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });

    // Integration: rawBody + per-route auth + DB all worked end-to-end — the
    // event was processed and persisted a bridged conversation + message.
    const conv = await Conversation.findOne({ "bridge.externalChatId": "tg-123" });
    expect(conv).not.toBeNull();
    const msg = await Message.findOne({ "external.externalMessageId": "tg-msg-1" });
    expect(msg?.senderId).toBe("ext:telegram:tg-123");
    expect(msg?.senderDeviceId).toBe(0);
  });

  it("rejects a bad signature with 401", async () => {
    const app = buildBridgeApp();
    const ts = String(Date.now());
    const res = await request(app)
      .post("/internal/bridge/events")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .set(BRIDGE_SIGNATURE_HEADER, "deadbeef")
      .send(validMessageEvent);
    expect(res.status).toBe(401);
  });

  it("rejects a signature computed for a DIFFERENT path (cross-endpoint replay) with 401", async () => {
    // Finding 2: a signature valid for /some/other/path must NOT authenticate a
    // request to /internal/bridge/events, even with a fresh timestamp + matching
    // body. The verifier binds the stable BRIDGE_EVENTS_PATH into the HMAC.
    const app = buildBridgeApp();
    const rawBody = JSON.stringify(validMessageEvent);
    const ts = String(Date.now());
    const sigForOtherPath = signEvents(ts, rawBody, "/internal/bridge/somewhere-else");
    const res = await request(app)
      .post("/internal/bridge/events")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .set(BRIDGE_SIGNATURE_HEADER, sigForOtherPath)
      .set("Content-Type", "application/json")
      .send(rawBody);
    expect(res.status).toBe(401);

    // Sanity: signing the CORRECT path with the same ts/body would authenticate.
    expect(signEvents(ts, rawBody, BRIDGE_EVENTS_PATH)).not.toBe(sigForOtherPath);
  });

  it("rejects a stale timestamp with 401", async () => {
    const app = buildBridgeApp();
    const rawBody = JSON.stringify(validMessageEvent);
    const staleTs = String(Date.now() - (BRIDGE_TIMESTAMP_TOLERANCE_MS + 60 * 1000));
    const res = await request(app)
      .post("/internal/bridge/events")
      .set(BRIDGE_TIMESTAMP_HEADER, staleTs)
      .set(BRIDGE_SIGNATURE_HEADER, signEvents(staleTs, rawBody))
      .set("Content-Type", "application/json")
      .send(rawBody);
    expect(res.status).toBe(401);
  });

  it("rejects a future timestamp with 401", async () => {
    const app = buildBridgeApp();
    const rawBody = JSON.stringify(validMessageEvent);
    const futureTs = String(Date.now() + (BRIDGE_TIMESTAMP_TOLERANCE_MS + 60 * 1000));
    const res = await request(app)
      .post("/internal/bridge/events")
      .set(BRIDGE_TIMESTAMP_HEADER, futureTs)
      .set(BRIDGE_SIGNATURE_HEADER, signEvents(futureTs, rawBody))
      .set("Content-Type", "application/json")
      .send(rawBody);
    expect(res.status).toBe(401);
  });

  it("rejects missing auth headers with 401", async () => {
    const app = buildBridgeApp();
    const res = await request(app).post("/internal/bridge/events").send(validMessageEvent);
    expect(res.status).toBe(401);
  });

  it("returns 500 'Bridge not configured' when the secret is too short", async () => {
    // Finding 6: a present-but-short secret is coerced to undefined upstream, so
    // even an otherwise-valid request hits the not-configured 500 path.
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET_TOO_SHORT;
    const app = buildBridgeApp();
    const rawBody = JSON.stringify(validMessageEvent);
    const ts = String(Date.now());
    const res = await request(app)
      .post("/internal/bridge/events")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      // Sign with the short secret so only the length guard can be the failure.
      .set(BRIDGE_SIGNATURE_HEADER, signEvents(ts, rawBody, BRIDGE_EVENTS_PATH, "POST", TEST_BRIDGE_SECRET_TOO_SHORT))
      .set("Content-Type", "application/json")
      .send(rawBody);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Bridge not configured");
  });
});

describe("bridgeAuth middleware (flag OFF)", () => {
  const prevEnabled = process.env.BRIDGE_ENABLED;

  afterEach(() => {
    process.env.BRIDGE_ENABLED = prevEnabled;
  });

  it("returns 404 when BRIDGE_ENABLED is unset", async () => {
    delete process.env.BRIDGE_ENABLED;
    const app = express();
    app.use("/internal/bridge", express.json({ verify: captureRawBody }), internalBridgeRouter);
    const ts = String(Date.now());
    const res = await request(app)
      .post("/internal/bridge/events")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .send(validMessageEvent);
    expect(res.status).toBe(404);
  });
});
