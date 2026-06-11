import request from "supertest";
import { buildApp } from "./testApp";
import bridgeRoutes from "../routes/bridge";
import LinkedAccount from "../models/LinkedAccount";
import ExternalContact from "../models/ExternalContact";
import Conversation from "../models/Conversation";

const OWNER = "owner-1";
const TOKEN = `Bearer ${OWNER}`;

function makeApp() {
  return buildApp({
    withAuth: true,
    mount: [{ path: "/api/bridge", router: bridgeRoutes }],
  });
}

describe("User-facing bridge routes", () => {
  const prevEnabled = process.env.BRIDGE_ENABLED;
  const prevSecret = process.env.BRIDGE_SHARED_SECRET;
  const prevUrl = process.env.BRIDGE_SERVICE_URL;

  beforeEach(() => {
    process.env.BRIDGE_ENABLED = "true";
    process.env.BRIDGE_SHARED_SECRET = "s3cr3t";
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
});
