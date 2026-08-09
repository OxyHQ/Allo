import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { uuidv7 } from "@oxyhq/db";

import { resetBridgesConfigForTests } from "../../config/bridges";
import { closePostgres, connectPostgres, getDb } from "../../db";
import * as schema from "../../db/schema";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import { createBridgeInternalRoutes } from "../../routes/bridgesInternal";
import { resetProxyProviderForTests } from "../../services/bridges/proxy/proxyProvider";
import { resetProxyUrlCacheForTests } from "../../services/bridges/proxy/ProxyLeaseService";

/**
 * `/internal/bridges/*` — the endpoints only a bridge ever calls
 * (docs/matrix/bridges.md §5.4, §8.3 rule 6).
 *
 * Assembled the way `server.ts` assembles them: mounted with NO outer body
 * parser and NO Oxy authentication ahead of them. That placement is part of the
 * correctness, so the app here reproduces it rather than approximating it.
 */

const SECRET = "a-shared-secret-that-is-long-enough-32";
const TELEGRAM_AS_TOKEN = "telegram-as-token-long-enough-32-chars";
const SLACK_AS_TOKEN = "slack-as-token-that-is-long-enough-32x";
const PROXY_ENDPOINT_TOKEN = "a-proxy-endpoint-token-32-chars-long-x";
const USER = "aaaaaaaaaaaaaaaaaaaaaaaa";

function internalApp(): express.Express {
  const app = express();
  app.use("/internal/bridges", createBridgeInternalRoutes());
  return app;
}

function enableTelegramAndSlack(): void {
  process.env.ALLO_BRIDGES_ENABLED = "telegram,slack";
  process.env.ALLO_MATRIX_SERVER_NAME = "allo.you";
  process.env.ALLO_BRIDGE_TELEGRAM_BASE_URL = "http://bridge-telegram:29317";
  process.env.ALLO_BRIDGE_TELEGRAM_SHARED_SECRET = SECRET;
  process.env.ALLO_BRIDGE_TELEGRAM_AS_TOKEN = TELEGRAM_AS_TOKEN;
  process.env.ALLO_BRIDGE_SLACK_BASE_URL = "http://bridge-slack:29318";
  process.env.ALLO_BRIDGE_SLACK_SHARED_SECRET = SECRET;
  process.env.ALLO_BRIDGE_SLACK_AS_TOKEN = SLACK_AS_TOKEN;
}

function enableProxyProvider(): void {
  process.env.ALLO_BRIDGE_PROXY_PROVIDER = "provider-a";
  process.env.ALLO_BRIDGE_PROXY_GATEWAY = "http://gateway.example:8000";
  process.env.ALLO_BRIDGE_PROXY_USERNAME_TEMPLATE = "acct-country-{country}-session-{session}";
  process.env.ALLO_BRIDGE_PROXY_PASSWORD = "a-proxy-password";
  process.env.ALLO_BRIDGE_PROXY_ENDPOINT_TOKEN = PROXY_ENDPOINT_TOKEN;
}

function clearEnvironment(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ALLO_BRIDGE") || key === "ALLO_MATRIX_SERVER_NAME") {
      delete process.env[key];
    }
  }
}

/**
 * ONE throwaway database for the whole file, at file scope. Both describe blocks
 * write these tables, and a describe-scoped `afterAll` would drop the database
 * out from under the second one.
 */
let handle: TestDatabaseHandle;

beforeAll(async () => {
  handle = await setUpTestDatabase();
  connectPostgres(handle.databaseUrl);
}, 180_000);

afterAll(async () => {
  await closePostgres();
  await handle?.drop();
});

async function storedAccount(id: string) {
  const [row] = await getDb()
    .select()
    .from(schema.bridgeAccounts)
    .where(eq(schema.bridgeAccounts.id, id));
  return row;
}

async function clearBridgeTables(): Promise<void> {
  // Leases first only for symmetry; there is no FK between the two.
  await getDb().delete(schema.bridgeProxyLeases);
  await getDb().delete(schema.bridgeAccounts);
}

describe("the bridge status webhook", () => {
  beforeEach(() => {
    enableTelegramAndSlack();
    resetBridgesConfigForTests();
    resetProxyProviderForTests();
    resetProxyUrlCacheForTests();
  });

  afterEach(async () => {
    clearEnvironment();
    resetBridgesConfigForTests();
    resetProxyProviderForTests();
    resetProxyUrlCacheForTests();
    await clearBridgeTables();
  });

  async function linkedAccount(
    overrides: Partial<typeof schema.bridgeAccounts.$inferInsert> = {},
  ) {
    const [row] = await getDb()
      .insert(schema.bridgeAccounts)
      .values({
        id: uuidv7(),
        oxyUserId: USER,
        network: "telegram",
        remoteLoginId: "remote-login-1",
        state: "connecting",
        linkedAt: new Date(),
        lastStateAt: new Date(),
        ...overrides,
      })
      .returning();
    if (!row) throw new Error("bridge account fixture returned no row");
    return row;
  }

  it("refuses a report with no bearer token", async () => {
    const response = await request(internalApp())
      .post("/internal/bridges/status")
      .set("content-type", "application/json")
      .send({ state_event: "CONNECTED", remote_id: "remote-login-1" });

    expect(response.status).toBe(401);
  });

  it("refuses a report bearing a token no bridge owns", async () => {
    const response = await request(internalApp())
      .post("/internal/bridges/status")
      .set("authorization", "Bearer a-token-nobody-configured-at-all-32")
      .send({ state_event: "CONNECTED", remote_id: "remote-login-1" });

    expect(response.status).toBe(401);
  });

  it("accepts a report bearing the bridge's own as_token", async () => {
    /**
     * The vacuity guard for the two above: without it, a route that answered 401
     * unconditionally — or one that was never mounted — would satisfy both.
     */
    const account = await linkedAccount();

    const response = await request(internalApp())
      .post("/internal/bridges/status")
      .set("authorization", `Bearer ${TELEGRAM_AS_TOKEN}`)
      .send({
        state_event: "CONNECTED",
        remote_id: "remote-login-1",
        user_id: `@${USER}:allo.you`,
      });

    expect(response.status).toBe(200);
    const stored = await storedAccount(account.id);
    expect(stored?.state).toBe("connected");
    expect(stored?.lastConnectedAt).toBeInstanceOf(Date);
  });

  it("does not let one bridge's token report about another bridge's network", async () => {
    /**
     * The token does not merely authenticate, it IDENTIFIES. Slack's as_token
     * must not be able to move the state of a Telegram account: a compromise of
     * one bridge would otherwise be a compromise of every network's state.
     */
    const account = await linkedAccount();

    const response = await request(internalApp())
      .post("/internal/bridges/status")
      .set("authorization", `Bearer ${SLACK_AS_TOKEN}`)
      .send({
        state_event: "BAD_CREDENTIALS",
        remote_id: "remote-login-1",
        user_id: `@${USER}:allo.you`,
      });

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(false);
    const stored = await storedAccount(account.id);
    expect(stored?.state).toBe("connecting");
  });

  it("ignores a report about a user of another homeserver", async () => {
    /**
     * A bridge is only ever meant to report about users of OUR homeserver.
     * Parsing `@someone:elsewhere.example` and keeping the localpart would let a
     * misconfigured or compromised bridge write state onto a row keyed by a
     * localpart it does not own.
     */
    const account = await linkedAccount();

    const response = await request(internalApp())
      .post("/internal/bridges/status")
      .set("authorization", `Bearer ${TELEGRAM_AS_TOKEN}`)
      .send({
        state_event: "LOGGED_OUT",
        remote_id: "remote-login-1",
        user_id: `@${USER}:elsewhere.example`,
      });

    expect(response.body.matched).toBe(false);
    const stored = await storedAccount(account.id);
    expect(stored?.state).toBe("connecting");
  });

  it("answers 2xx for a lifecycle report that matches no account", async () => {
    /**
     * Bridges report their own lifecycle too, and those carry no `remote_id`.
     * A non-2xx would put a message that can never match onto a retry schedule
     * forever.
     */
    const response = await request(internalApp())
      .post("/internal/bridges/status")
      .set("authorization", `Bearer ${TELEGRAM_AS_TOKEN}`)
      .send({ state_event: "STARTING" });

    expect(response.status).toBe(200);
    expect(response.body.matched).toBe(false);
  });

  it("is not satisfied by an Oxy session", async () => {
    /**
     * This is not a user endpoint. The as_token IS the authentication, and a
     * bearer that looks like a user's access token must not pass.
     */
    const response = await request(internalApp())
      .post("/internal/bridges/status")
      .set("authorization", "Bearer a-perfectly-valid-looking-user-token")
      .send({ state_event: "CONNECTED", remote_id: "remote-login-1" });

    expect(response.status).toBe(401);
  });

  it("parses its own body, without a parser mounted ahead of it", async () => {
    /**
     * `server.ts` mounts this router BEFORE `express.json()`, so that an Oxy
     * session cannot satisfy it and the per-user rate limiter cannot throttle
     * it. That only works if the router brings its own parser — otherwise the
     * placement that provides the security property also breaks the endpoint.
     *
     * The app in this file has no outer parser at all, which is what makes this
     * assertion mean something.
     */
    const account = await linkedAccount();

    const response = await request(internalApp())
      .post("/internal/bridges/status")
      .set("authorization", `Bearer ${TELEGRAM_AS_TOKEN}`)
      .set("content-type", "application/json")
      .send(
        JSON.stringify({
          state_event: "BAD_CREDENTIALS",
          remote_id: "remote-login-1",
          user_id: `@${USER}:allo.you`,
        }),
      );

    expect(response.status).toBe(200);
    const stored = await storedAccount(account.id);
    expect(stored?.state).toBe("action_required");
    expect(stored?.rawStateEvent).toBe("BAD_CREDENTIALS");
  });

  it("keeps the bridge's own state alongside the collapsed one", async () => {
    /**
     * §5.3: `BAD_CREDENTIALS` and `LOGGED_OUT` are the same thing to a user and
     * completely different to us — a rise in `LOGGED_OUT` on one network is the
     * early shape of a ban wave. Collapsing without keeping the original makes
     * that distinction unrecoverable.
     */
    const account = await linkedAccount();

    await request(internalApp())
      .post("/internal/bridges/status")
      .set("authorization", `Bearer ${TELEGRAM_AS_TOKEN}`)
      .send({
        state_event: "LOGGED_OUT",
        remote_id: "remote-login-1",
        user_id: `@${USER}:allo.you`,
        ttl: 3600,
      });

    const stored = await storedAccount(account.id);
    expect(stored?.state).toBe("action_required");
    expect(stored?.rawStateEvent).toBe("LOGGED_OUT");
    expect(stored?.rawStateTtl).toBe(3600);
  });
});

describe("the proxy endpoint the bridge asks on every connect", () => {
  beforeEach(async () => {
    enableTelegramAndSlack();
    enableProxyProvider();
    resetBridgesConfigForTests();
    resetProxyProviderForTests();
    resetProxyUrlCacheForTests();

    await getDb().insert(schema.bridgeAccounts).values({
      id: uuidv7(),
      oxyUserId: USER,
      network: "telegram",
      remoteLoginId: "remote-login-1",
      slotId: "allo-wa-0042",
      state: "connected",
      linkedAt: new Date(),
      lastStateAt: new Date(),
    });
    await getDb().insert(schema.bridgeProxyLeases).values({
      id: uuidv7(),
      oxyUserId: USER,
      network: "telegram",
      provider: "provider-a",
      countryCode: "ES",
      sessionSeed: "seed-abc123",
      state: "active",
    });
  });

  afterEach(async () => {
    clearEnvironment();
    resetBridgesConfigForTests();
    resetProxyProviderForTests();
    resetProxyUrlCacheForTests();
    await clearBridgeTables();
  });

  it("answers with a field called exactly proxy_url", async () => {
    /**
     * §8.3 rule 6: `proxy_url` is what the bridge deserialises. A different
     * name — `proxyUrl`, say — parses as valid JSON, deserialises to an empty
     * string, and the bridge connects with NO proxy at all. Every user of that
     * network then egresses from the datacentre, which is the exact failure the
     * whole design exists to prevent, arriving as a success response.
     */
    const response = await request(internalApp())
      .get("/internal/bridges/proxy")
      .query({ slot: "allo-wa-0042", t: PROXY_ENDPOINT_TOKEN, reason: "connect" });

    expect(response.status).toBe(200);
    expect(Object.keys(response.body)).toEqual(["proxy_url"]);
    expect(response.body.proxy_url).toContain("country-es");
    expect(response.body.proxy_url).toContain("session-seed-abc123");
  });

  it("answers 404 — not 403 — for a wrong token", async () => {
    /**
     * The same answer as an unknown slot, so the endpoint cannot be used to
     * confirm that a slot id exists.
     */
    const response = await request(internalApp())
      .get("/internal/bridges/proxy")
      .query({ slot: "allo-wa-0042", t: "a-token-nobody-configured-32-chars-x" });

    expect(response.status).toBe(404);
    expect(response.status).not.toBe(403);
    expect(response.body.proxy_url).toBeUndefined();
  });

  it("answers 404 for a missing token", async () => {
    const response = await request(internalApp())
      .get("/internal/bridges/proxy")
      .query({ slot: "allo-wa-0042" });

    expect(response.status).toBe(404);
  });

  it("gives an unknown slot the same answer as a wrong token", async () => {
    const response = await request(internalApp())
      .get("/internal/bridges/proxy")
      .query({ slot: "allo-wa-9999", t: PROXY_ENDPOINT_TOKEN });

    expect(response.status).toBe(404);
  });

  it("refuses to serve a quarantined lease", async () => {
    /**
     * §8.3 rule 5's other half. A quarantined lease is one whose geography we
     * have already decided not to trust; serving it would connect the account
     * through a country we know is wrong. The bridge failing to connect is the
     * intended outcome.
     */
    await getDb()
      .update(schema.bridgeProxyLeases)
      .set({ state: "quarantined" })
      .where(
        and(
          eq(schema.bridgeProxyLeases.oxyUserId, USER),
          eq(schema.bridgeProxyLeases.network, "telegram"),
        ),
      );
    resetProxyUrlCacheForTests();

    const response = await request(internalApp())
      .get("/internal/bridges/proxy")
      .query({ slot: "allo-wa-0042", t: PROXY_ENDPOINT_TOKEN });

    expect(response.status).toBe(404);
  });

  it("is not mounted at all when no proxy provider is configured", async () => {
    /**
     * Not mounted, rather than mounted and refusing. With no provider there is
     * no network that could ask, and a route that answers anything is one that
     * will eventually be reasoned about as if it served something real.
     */
    delete process.env.ALLO_BRIDGE_PROXY_PROVIDER;
    delete process.env.ALLO_BRIDGE_PROXY_GATEWAY;
    delete process.env.ALLO_BRIDGE_PROXY_USERNAME_TEMPLATE;
    delete process.env.ALLO_BRIDGE_PROXY_PASSWORD;
    resetBridgesConfigForTests();
    resetProxyProviderForTests();

    const response = await request(internalApp())
      .get("/internal/bridges/proxy")
      .query({ slot: "allo-wa-0042", t: PROXY_ENDPOINT_TOKEN });

    expect(response.status).toBe(404);
  });
});

describe("nothing internal is mounted when no network is enabled", () => {
  beforeEach(() => {
    clearEnvironment();
    resetBridgesConfigForTests();
    resetProxyProviderForTests();
  });

  afterEach(() => {
    resetBridgesConfigForTests();
  });

  it("404s the status endpoint rather than answering it", async () => {
    const response = await request(internalApp())
      .post("/internal/bridges/status")
      .set("authorization", `Bearer ${TELEGRAM_AS_TOKEN}`)
      .send({ state_event: "CONNECTED", remote_id: "remote-login-1" });

    expect(response.status).toBe(404);
  });
});
