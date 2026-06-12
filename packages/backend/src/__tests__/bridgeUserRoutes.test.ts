import request from "supertest";
import { buildApp } from "./testApp";
import bridgeRoutes from "../routes/bridge";
import LinkedAccount from "../models/LinkedAccount";
import ExternalContact from "../models/ExternalContact";
import Conversation from "../models/Conversation";
import { TEST_BRIDGE_SECRET } from "./helpers/bridgeFixtures";

const OWNER = "owner-1";
const TOKEN = `Bearer ${OWNER}`;

function makeApp() {
  return buildApp({
    withAuth: true,
    mount: [{ path: "/api/bridge", router: bridgeRoutes }],
  });
}

/** Parse the JSON body that the proxy POSTed to the connector via a mocked fetch. */
function proxiedBody(spy: jest.SpyInstance): Record<string, unknown> {
  const lastCall = spy.mock.calls[spy.mock.calls.length - 1];
  const init = lastCall[1] as { body?: string };
  return JSON.parse(init.body ?? "{}") as Record<string, unknown>;
}

describe("User-facing bridge routes", () => {
  const prevEnabled = process.env.BRIDGE_ENABLED;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  const prevUrl = process.env.BRIDGE_SERVICE_URL;

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = TEST_BRIDGE_SECRET;
    process.env.BRIDGE_SERVICE_URL = "http://bridge.test";
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.BRIDGE_ENABLED = prevEnabled;
    process.env.BRIDGE_SHARED_SECRET = prevSecret;
    process.env.BRIDGE_SERVICE_URL = prevUrl;
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await request(makeApp()).get("/api/bridge/accounts");
    expect(res.status).toBe(401);
  });

  it("GET /accounts returns the user's linked accounts", async () => {
    await LinkedAccount.create({ userId: OWNER, network: "telegram", status: "active" });
    const res = await request(makeApp()).get("/api/bridge/accounts").set("Authorization", TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.data.accounts).toHaveLength(1);
    expect(res.body.data.accounts[0].network).toBe("telegram");
  });

  it("GET /contacts?network= returns external contacts", async () => {
    await ExternalContact.create({
      ownerUserId: OWNER,
      network: "telegram",
      externalId: "tg-123",
      displayName: "Alice",
    });
    const res = await request(makeApp())
      .get("/api/bridge/contacts?network=telegram")
      .set("Authorization", TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.data.contacts).toHaveLength(1);
    expect(res.body.data.contacts[0].displayName).toBe("Alice");
  });

  it("GET /contacts rejects an unknown network with 400", async () => {
    const res = await request(makeApp())
      .get("/api/bridge/contacts?network=myspace")
      .set("Authorization", TOKEN);
    expect(res.status).toBe(400);
  });

  it("POST /conversations creates a bridged conversation tagged network:'telegram'", async () => {
    const res = await request(makeApp())
      .post("/api/bridge/conversations")
      .set("Authorization", TOKEN)
      .send({ network: "telegram", externalId: "tg-123" });

    expect(res.status).toBe(200);
    expect(res.body.data.network).toBe("telegram");
    expect(res.body.data.bridge.externalChatId).toBe("tg-123");

    const count = await Conversation.countDocuments({ "bridge.externalChatId": "tg-123" });
    expect(count).toBe(1);
  });

  it("POST /conversations rejects an unknown network with 400", async () => {
    const res = await request(makeApp())
      .post("/api/bridge/conversations")
      .set("Authorization", TOKEN)
      .send({ network: "myspace", externalId: "x" });
    expect(res.status).toBe(400);
  });

  it("POST /accounts/:network/link returns the bridge payload and upserts pending_login", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ qr: "login-token" }), { status: 200 }));

    const res = await request(makeApp())
      .post("/api/bridge/accounts/telegram/link")
      .set("Authorization", TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ qr: "login-token" });

    const account = await LinkedAccount.findOne({ userId: OWNER, network: "telegram" });
    expect(account?.status).toBe("pending_login");
  });

  it("POST /accounts/:network/link returns 502 when the connector is unreachable", async () => {
    jest.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await request(makeApp())
      .post("/api/bridge/accounts/telegram/link")
      .set("Authorization", TOKEN)
      .send({});

    expect(res.status).toBe(502);
  });

  it("POST /accounts/:network/link rejects an unknown network with 400", async () => {
    const res = await request(makeApp())
      .post("/api/bridge/accounts/myspace/link")
      .set("Authorization", TOKEN)
      .send({});
    expect(res.status).toBe(400);
  });

  it("Fix 2: POST /accounts/:network/link forwards the client body (e.g. phoneNumber) to the connector", async () => {
    const spy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ v: 1, status: "needs_code" }), { status: 200 }));

    const res = await request(makeApp())
      .post("/api/bridge/accounts/telegram/link")
      .set("Authorization", TOKEN)
      .send({ phoneNumber: "+34123456789" });

    expect(res.status).toBe(200);
    const sent = proxiedBody(spy);
    expect(sent.ownerUserId).toBe(OWNER);
    expect(sent.phoneNumber).toBe("+34123456789");
  });

  it("Fix 2: a client CANNOT override ownerUserId in the link body", async () => {
    const spy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ v: 1, status: "pending" }), { status: 200 }));

    const res = await request(makeApp())
      .post("/api/bridge/accounts/telegram/link")
      .set("Authorization", TOKEN)
      .send({ ownerUserId: "attacker", phoneNumber: "+34123456789" });

    expect(res.status).toBe(200);
    const sent = proxiedBody(spy);
    expect(sent.ownerUserId).toBe(OWNER); // authenticated id wins, not "attacker"
    expect(sent.phoneNumber).toBe("+34123456789");
  });

  it("Fix 2: the connector's link response is relayed to the client verbatim", async () => {
    jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ v: 1, status: "needs_code", loginUrl: "https://x/qr" }), {
          status: 200,
        })
      );

    const res = await request(makeApp())
      .post("/api/bridge/accounts/telegram/link")
      .set("Authorization", TOKEN)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ v: 1, status: "needs_code", loginUrl: "https://x/qr" });
  });

  it("Fix 2: a non-object link body (array) is ignored; only ownerUserId is sent", async () => {
    const spy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ v: 1, status: "pending" }), { status: 200 }));

    // Express parses a JSON array body as an array; it must not corrupt the payload.
    const res = await request(makeApp())
      .post("/api/bridge/accounts/telegram/link")
      .set("Authorization", TOKEN)
      .set("Content-Type", "application/json")
      .send(JSON.stringify(["not", "an", "object"]));

    expect(res.status).toBe(200);
    const sent = proxiedBody(spy);
    expect(sent.ownerUserId).toBe(OWNER);
    expect(Array.isArray(sent)).toBe(false);
  });

  it("Fix 2: POST /accounts/:network/link/code forwards the full body and keeps ownerUserId authoritative", async () => {
    const spy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ v: 1, status: "needs_password" }), { status: 200 })
      );

    const res = await request(makeApp())
      .post("/api/bridge/accounts/telegram/link/code")
      .set("Authorization", TOKEN)
      .send({ code: "12345", phoneCodeHash: "abc", ownerUserId: "attacker" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ v: 1, status: "needs_password" });
    const sent = proxiedBody(spy);
    expect(sent.ownerUserId).toBe(OWNER);
    expect(sent.code).toBe("12345");
    expect(sent.phoneCodeHash).toBe("abc");
  });

  it("Fix 2: POST /accounts/:network/link/password forwards the full body and keeps ownerUserId authoritative", async () => {
    const spy = jest
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ v: 1, status: "active" }), { status: 200 }));

    const res = await request(makeApp())
      .post("/api/bridge/accounts/telegram/link/password")
      .set("Authorization", TOKEN)
      .send({ password: "s3cr3t", ownerUserId: "attacker" });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ v: 1, status: "active" });
    const sent = proxiedBody(spy);
    expect(sent.ownerUserId).toBe(OWNER);
    expect(sent.password).toBe("s3cr3t");
  });
});
