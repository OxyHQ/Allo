import express from "express";
import request from "supertest";
import crypto from "crypto";
import { bridgeAuth, captureRawBody } from "../middleware/bridgeAuth";
import internalBridgeRouter from "../routes/internalBridge";
import {
  BRIDGE_TIMESTAMP_HEADER,
  BRIDGE_SIGNATURE_HEADER,
  BRIDGE_TIMESTAMP_TOLERANCE_MS,
} from "../config/bridge";
import { installMockMessaging, type MockMessaging } from "./helpers/mockSocket";
import Conversation from "../models/Conversation";
import Message from "../models/Message";

const SECRET = "s3cr3t";

function sign(timestamp: string, rawBody: string): string {
  return crypto.createHmac("sha256", SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
}

/** Mirror the REAL server mount: scoped raw-body json -> bridgeAuth -> router. */
function buildBridgeApp() {
  const app = express();
  app.use(
    "/internal/bridge",
    express.json({ verify: captureRawBody }),
    bridgeAuth,
    internalBridgeRouter
  );
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
    process.env.BRIDGE_SHARED_SECRET = SECRET;
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
    const app = buildBridgeApp();
    const rawBody = JSON.stringify(validMessageEvent);
    const ts = String(Date.now());
    const res = await request(app)
      .post("/internal/bridge/events")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .set(BRIDGE_SIGNATURE_HEADER, sign(ts, rawBody))
      .set("Content-Type", "application/json")
      .send(rawBody);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ ok: true });

    // Integration: rawBody + auth + DB all worked — the event was processed and
    // persisted a bridged conversation and the plaintext message.
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

  it("rejects a stale timestamp with 401", async () => {
    const app = buildBridgeApp();
    const rawBody = JSON.stringify(validMessageEvent);
    const staleTs = String(Date.now() - (BRIDGE_TIMESTAMP_TOLERANCE_MS + 60 * 1000));
    const res = await request(app)
      .post("/internal/bridge/events")
      .set(BRIDGE_TIMESTAMP_HEADER, staleTs)
      .set(BRIDGE_SIGNATURE_HEADER, sign(staleTs, rawBody))
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
      .set(BRIDGE_SIGNATURE_HEADER, sign(futureTs, rawBody))
      .set("Content-Type", "application/json")
      .send(rawBody);
    expect(res.status).toBe(401);
  });

  it("rejects missing auth headers with 401", async () => {
    const app = buildBridgeApp();
    const res = await request(app).post("/internal/bridge/events").send(validMessageEvent);
    expect(res.status).toBe(401);
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
    app.use("/internal/bridge", express.json({ verify: captureRawBody }), bridgeAuth, internalBridgeRouter);
    const ts = String(Date.now());
    const res = await request(app)
      .post("/internal/bridge/events")
      .set(BRIDGE_TIMESTAMP_HEADER, ts)
      .send(validMessageEvent);
    expect(res.status).toBe(404);
  });
});
