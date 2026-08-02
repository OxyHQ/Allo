import express from "express";
import http from "http";
import type { AddressInfo } from "net";
import mongoose from "mongoose";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { resetBridgesConfigForTests } from "../../config/bridges";
import BridgeAccount from "../../models/BridgeAccount";
import BridgeLinkSession, {
  type LeanBridgeLinkSession,
} from "../../models/BridgeLinkSession";
import BridgeProxyLease from "../../models/BridgeProxyLease";
import bridgesRouter from "../../routes/bridges";
import { resetBridgeFlowCacheForTests } from "../../services/bridges/BridgeLinkService";

/**
 * `/api/bridges/*` against a REAL stub bridge (docs/matrix/bridges.md §5.1, §5.2, §9).
 *
 * The stub is an actual HTTP server rather than a mocked client, because the two
 * properties that matter most are only visible on the wire:
 *
 * - **§5.1**: the `?user_id=` a bridge is called with must come from the
 *   authenticated Oxy identity and from nothing else. The provisioning shared
 *   secret makes a bridge believe that parameter without further checks, so the
 *   only convincing test is one that reads what the bridge actually received.
 * - **§9.2 rule 3**: a disabled network answers 404 and not 403.
 *
 * A mocked client would let both claims be asserted about a function call while
 * the request on the wire said something else.
 */

const SECRET = "a-shared-secret-that-is-long-enough-32";
const AS_TOKEN = "an-as-token-that-is-also-long-enough-32";
const USER = "aaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_USER = "bbbbbbbbbbbbbbbbbbbbbbbb";

interface RecordedCall {
  readonly method: string;
  readonly path: string;
  readonly userId: string | null;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

interface StubBridge {
  readonly origin: string;
  readonly calls: RecordedCall[];
  /** The step `POST /login/step/...` will answer with next. */
  nextStep: unknown;
  startStep: unknown;
  close(): Promise<void>;
}

async function startStubBridge(): Promise<StubBridge> {
  const calls: RecordedCall[] = [];
  const state: { nextStep: unknown; startStep: unknown } = {
    startStep: {
      type: "user_input",
      step_id: "fi.mau.telegram.login.phone_number",
      login_id: "login-process-1",
      instructions: "Enter your phone number",
      user_input: {
        fields: [
          {
            type: "phone_number",
            id: "fi.mau.telegram.login.phone_number",
            name: "Phone number",
            pattern: "^\\+[0-9]+$",
          },
        ],
      },
    },
    nextStep: {
      type: "user_input",
      step_id: "fi.mau.telegram.login.code",
      user_input: { fields: [{ type: "2fa_code", id: "fi.mau.telegram.login.code" }] },
    },
  };

  const app = express();
  app.use(express.json());

  app.use((req, _res, next) => {
    calls.push({
      method: req.method,
      path: req.path,
      userId: typeof req.query.user_id === "string" ? req.query.user_id : null,
      authorization: req.get("authorization"),
      body: req.body,
    });
    next();
  });

  app.get("/_matrix/provision/v3/login/flows", (_req, res) => {
    res.json({
      flows: [
        { id: "phone", name: "Phone number", description: "Log in with your number" },
        { id: "qr", name: "QR code" },
        { id: "bot", name: "Bot token" },
        { id: "manual", name: "Manual", description: "advanced, do not use" },
      ],
    });
  });

  app.post("/_matrix/provision/v3/login/start/:flow", (_req, res) => {
    res.json(state.startStep);
  });

  app.post("/_matrix/provision/v3/login/step/:process/:step/:type", (_req, res) => {
    res.json(state.nextStep);
  });

  app.post("/_matrix/provision/v3/login/cancel/:process", (_req, res) => {
    res.json({});
  });

  app.post("/_matrix/provision/v3/logout/:login", (_req, res) => {
    res.json({});
  });

  app.get("/_matrix/provision/v3/whoami", (_req, res) => {
    res.json({
      logins: [
        {
          id: "remote-login-1",
          name: "Ada",
          state: "CONNECTED",
          space_room: "!space:allo.you",
          profile: { name: "Ada L", phone: "+34600111222" },
        },
      ],
    });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    calls,
    get nextStep() {
      return state.nextStep;
    },
    set nextStep(value: unknown) {
      state.nextStep = value;
    },
    get startStep() {
      return state.startStep;
    },
    set startStep(value: unknown) {
      state.startStep = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * An app assembled the way `server.ts` assembles it, minus Oxy.
 *
 * The stand-in authentication sets exactly what `getRequiredOxyUserId` reads.
 * It takes the user from a header so a test can act as somebody else — which is
 * how "one user cannot touch another's link" is asserted without inventing a
 * second identity provider.
 */
function appWithAuth(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.get("x-test-user") ?? USER;
    Reflect.set(req, "userId", userId);
    Reflect.set(req, "user", { id: userId });
    next();
  });
  app.use("/api/bridges", bridgesRouter);
  return app;
}

let bridge: StubBridge;

describe("the bridge orchestration API", () => {
  beforeAll(async () => {
    const uri = process.env.ALLO_TEST_MONGODB_URI;
    if (!uri) throw new Error("ALLO_TEST_MONGODB_URI is not set by vitest.globalSetup.ts");
    await mongoose.connect(uri, { dbName: "allo_bridge_routes_test" });
    await BridgeAccount.init();
    await BridgeLinkSession.init();
    await BridgeProxyLease.init();
    bridge = await startStubBridge();
  });

  afterAll(async () => {
    await bridge.close();
    await mongoose.disconnect();
  });

  beforeEach(() => {
    process.env.ALLO_BRIDGES_ENABLED = "telegram";
    process.env.ALLO_MATRIX_SERVER_NAME = "allo.you";
    process.env.ALLO_BRIDGE_TELEGRAM_BASE_URL = bridge.origin;
    process.env.ALLO_BRIDGE_TELEGRAM_SHARED_SECRET = SECRET;
    process.env.ALLO_BRIDGE_TELEGRAM_AS_TOKEN = AS_TOKEN;
    resetBridgesConfigForTests();
    resetBridgeFlowCacheForTests();
    bridge.calls.length = 0;
  });

  afterEach(async () => {
    delete process.env.ALLO_BRIDGES_ENABLED;
    delete process.env.ALLO_MATRIX_SERVER_NAME;
    delete process.env.ALLO_BRIDGE_TELEGRAM_BASE_URL;
    delete process.env.ALLO_BRIDGE_TELEGRAM_SHARED_SECRET;
    delete process.env.ALLO_BRIDGE_TELEGRAM_AS_TOKEN;
    /**
     * Set by the one test that needs a second, proxy-requiring network. Cleared
     * here rather than there so that a failing assertion cannot leave a proxy
     * provider configured for every test that follows — which would silently make
     * WhatsApp enableable in tests written to assume it is not.
     */
    delete process.env.ALLO_BRIDGE_WHATSAPP_BASE_URL;
    delete process.env.ALLO_BRIDGE_WHATSAPP_SHARED_SECRET;
    delete process.env.ALLO_BRIDGE_WHATSAPP_AS_TOKEN;
    delete process.env.ALLO_BRIDGE_PROXY_PROVIDER;
    delete process.env.ALLO_BRIDGE_PROXY_GATEWAY;
    delete process.env.ALLO_BRIDGE_PROXY_USERNAME_TEMPLATE;
    delete process.env.ALLO_BRIDGE_PROXY_PASSWORD;
    resetBridgesConfigForTests();
    resetBridgeFlowCacheForTests();
    await BridgeAccount.deleteMany({});
    await BridgeLinkSession.deleteMany({});
    await BridgeProxyLease.deleteMany({});
  });

  describe("a disabled network does not exist", () => {
    it("answers 404 — not 403 — when linking a network that is off", async () => {
      /**
       * §9.2 rule 3, asserted as the difference it exists for. 403 says "this
       * exists but you may not", which is a roadmap the app can read by probing
       * identifiers. 404 says nothing.
       *
       * WhatsApp is a real catalogue entry, correctly spelled, and simply not
       * enabled — so this is the exact case where a careless implementation
       * would reach for 403.
       */
      const response = await request(appWithAuth())
        .post("/api/bridges/networks/whatsapp/link")
        .send({ flowId: "qr" });

      expect(response.status).toBe(404);
      expect(response.status).not.toBe(403);
    });

    it("answers the same 404 for a network that was never in the catalogue", async () => {
      /**
       * The two must be indistinguishable. If a disabled network answered
       * differently from an unknown one, the difference itself would enumerate
       * the catalogue.
       *
       * The shared status is pinned to 404 as well as compared, and that second
       * assertion is not redundant: a mutation changing `resolveNetwork` to 403
       * moves BOTH responses together and leaves an equality-only test perfectly
       * green. Measured, not assumed — it survived exactly that mutation until
       * this line was added.
       */
      const disabled = await request(appWithAuth())
        .post("/api/bridges/networks/whatsapp/link")
        .send({ flowId: "qr" });
      const unknown = await request(appWithAuth())
        .post("/api/bridges/networks/signal/link")
        .send({ flowId: "qr" });

      expect(disabled.status).toBe(404);
      expect(unknown.status).toBe(disabled.status);
      expect(unknown.body).toEqual(disabled.body);
    });

    it("never reaches the bridge for a disabled network", async () => {
      /**
       * The check has to happen BEFORE anything is provisioned. A 404 returned
       * after a login was already started on a bridge would be a flag that
       * reports "no" while the side effect happened anyway.
       */
      await request(appWithAuth())
        .post("/api/bridges/networks/whatsapp/link")
        .send({ flowId: "qr" });

      expect(bridge.calls).toHaveLength(0);
    });

    it("lists only enabled networks, and answers 200 for an enabled one", async () => {
      /**
       * The vacuity guard for all three above: without it, a router that 404'd
       * everything would satisfy them perfectly.
       */
      const catalogue = await request(appWithAuth()).get("/api/bridges/networks");

      expect(catalogue.status).toBe(200);
      expect(catalogue.body.data.networks.map((n: { id: string }) => n.id)).toEqual([
        "telegram",
      ]);

      const link = await request(appWithAuth())
        .post("/api/bridges/networks/telegram/link")
        .send({ flowId: "phone" });
      expect(link.status).toBe(201);
    });
  });

  describe("the catalogue is what the app renders", () => {
    it("hides the login flows no user should ever be offered", async () => {
      /**
       * §5.2: Telegram declares `bot` and `manual`, the latter described by the
       * bridge itself as "advanced, do not use". A flow the UI cannot draw must
       * not arrive at the UI.
       */
      const response = await request(appWithAuth()).get("/api/bridges/networks");

      const flows = response.body.data.networks[0].loginFlows.map(
        (flow: { id: string }) => flow.id,
      );
      expect(flows).toEqual(["phone", "qr"]);
    });

    it("tells the app which networks it must warn about before linking", async () => {
      /**
       * §8 and §9.2 rule 2. `requiresProxy` is the server's own word for "this
       * network's anti-fraud bans on correlated egress", and it is the only
       * thing the app can key an account-ban warning off without carrying a
       * network list of its own — which §9.2 forbids precisely so that turning a
       * network on stays an environment variable rather than an app release.
       *
       * Asserted as `false` on Telegram rather than merely present, because the
       * field is only useful if it DISCRIMINATES: a payload that said `true`
       * everywhere would warn about every network and teach users to dismiss it.
       */
      const response = await request(appWithAuth()).get("/api/bridges/networks");

      expect(response.body.data.networks[0]).toMatchObject({
        id: "telegram",
        requiresProxy: false,
      });
    });

    it("reports requiresProxy as true for the networks that actually need one", async () => {
      /**
       * The other half of the assertion above, and it is not symmetry for its own
       * sake — it is the half that has teeth.
       *
       * Pinning only Telegram's `false` is satisfied by a route that hardcodes
       * `false`, which is a catalogue that never warns anybody: WhatsApp and Meta
       * would be offered with no mention that they ban accounts caught on
       * unofficial clients. Measured, not assumed — this test was written after
       * `requiresProxy: network.requiresProxy` was mutated to `requiresProxy:
       * false` and the suite stayed green.
       *
       * WhatsApp needs a configured proxy provider to be enabled at all (§9.2
       * rule 2), so turning it on here means turning that on too. Both bridges
       * point at the same stub: what is under test is the catalogue's shape, not
       * the two processes a real deployment would run.
       */
      process.env.ALLO_BRIDGES_ENABLED = "telegram,whatsapp";
      process.env.ALLO_BRIDGE_WHATSAPP_BASE_URL = bridge.origin;
      process.env.ALLO_BRIDGE_WHATSAPP_SHARED_SECRET = SECRET;
      process.env.ALLO_BRIDGE_WHATSAPP_AS_TOKEN = AS_TOKEN;
      process.env.ALLO_BRIDGE_PROXY_PROVIDER = "provider-a";
      process.env.ALLO_BRIDGE_PROXY_GATEWAY = "http://gateway.example:8000";
      process.env.ALLO_BRIDGE_PROXY_USERNAME_TEMPLATE =
        "acct-country-{country}-session-{session}";
      process.env.ALLO_BRIDGE_PROXY_PASSWORD = "a-proxy-password";
      resetBridgesConfigForTests();
      resetBridgeFlowCacheForTests();

      const response = await request(appWithAuth()).get("/api/bridges/networks");

      const byId = new Map<string, { requiresProxy: boolean }>(
        response.body.data.networks.map(
          (network: { id: string; requiresProxy: boolean }) => [network.id, network],
        ),
      );

      expect(byId.get("whatsapp")?.requiresProxy).toBe(true);
      expect(byId.get("telegram")?.requiresProxy).toBe(false);
    });

    it("carries the capability the user has to be told about before linking", async () => {
      /**
       * §11: Telegram's secret chats cannot be bridged, and the reason is
       * architectural rather than a missing feature — a bridge authenticates as
       * a new device, and a secret chat's keys are bound to the device that
       * accepted it. A user who links Telegram and cannot find those chats will
       * conclude the bridge is broken.
       */
      const response = await request(appWithAuth()).get("/api/bridges/networks");

      expect(response.body.data.networks[0].capabilities).toMatchObject({
        secretChats: false,
      });
    });

    it("refuses to start a hidden flow even when it is named explicitly", async () => {
      /**
       * Filtering the catalogue decides what the app DRAWS and nothing about
       * what it can ask for. Without this check, a client could start Telegram's
       * `manual` flow — existing session credentials — just by naming it.
       */
      const response = await request(appWithAuth())
        .post("/api/bridges/networks/telegram/link")
        .send({ flowId: "manual" });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe("flow_not_found");
      expect(
        bridge.calls.some((call) => call.path.includes("/login/start/")),
      ).toBe(false);
    });
  });

  describe("the MXID comes from the session and from nowhere else", () => {
    it("calls the bridge as the authenticated user", async () => {
      await request(appWithAuth())
        .post("/api/bridges/networks/telegram/link")
        .send({ flowId: "phone" });

      const start = bridge.calls.find((call) => call.path.includes("/login/start/"));
      expect(start?.userId).toBe(`@${USER}:allo.you`);
      expect(start?.authorization).toBe(`Bearer ${SECRET}`);
    });

    it("ignores a user_id the caller tries to supply", async () => {
      /**
       * §5.1's non-negotiable rule, tested as the attack it prevents. The shared
       * secret makes the bridge believe `?user_id=` with no further checks, so a
       * caller who could influence it would be linking an account for somebody
       * else.
       *
       * Every plausible smuggling route is tried at once: body fields the route
       * might read by accident, and a query string that could be concatenated
       * into the outgoing URL.
       */
      await request(appWithAuth())
        .post("/api/bridges/networks/telegram/link?user_id=@victim:allo.you")
        .send({
          flowId: "phone",
          user_id: `@${OTHER_USER}:allo.you`,
          userId: OTHER_USER,
          mxid: `@${OTHER_USER}:allo.you`,
          oxyUserId: OTHER_USER,
        });

      const start = bridge.calls.find((call) => call.path.includes("/login/start/"));
      expect(start?.userId).toBe(`@${USER}:allo.you`);
      expect(start?.userId).not.toContain(OTHER_USER);
      expect(start?.userId).not.toContain("victim");
    });
  });

  describe("a login attempt belongs to one user", () => {
    async function startLinkAs(user: string) {
      const response = await request(appWithAuth())
        .post("/api/bridges/networks/telegram/link")
        .set("x-test-user", user)
        .send({ flowId: "phone" });
      return response.body.data.linkId as string;
    }

    it("does not let another user answer somebody else's step", async () => {
      /**
       * The link id is unguessable, but that is not what makes this safe —
       * scoping every lookup by the authenticated user is. An id that leaked
       * through a log or a screenshot must still be useless to anybody else.
       */
      const linkId = await startLinkAs(USER);

      const response = await request(appWithAuth())
        .post(`/api/bridges/links/${linkId}/submit`)
        .set("x-test-user", OTHER_USER)
        .send({ values: { "fi.mau.telegram.login.phone_number": "+34600111222" } });

      expect(response.status).toBe(404);
    });

    it("does not let another user read it either", async () => {
      const linkId = await startLinkAs(USER);

      const response = await request(appWithAuth())
        .get(`/api/bridges/links/${linkId}`)
        .set("x-test-user", OTHER_USER);

      expect(response.status).toBe(404);
    });

    it("lets the owner answer it", async () => {
      /** The vacuity guard: the 404s above are about the USER, not about the id. */
      const linkId = await startLinkAs(USER);

      const response = await request(appWithAuth())
        .post(`/api/bridges/links/${linkId}/submit`)
        .set("x-test-user", USER)
        .send({ values: { "fi.mau.telegram.login.phone_number": "+34600111222" } });

      expect(response.status).toBe(200);
      expect(response.body.data.step.stepId).toBe("fi.mau.telegram.login.code");
    });
  });

  describe("nothing the user typed is stored", () => {
    it("relays the answer to the bridge and keeps none of it", async () => {
      /**
       * §5.5, stated as a property of the database rather than of intent: no
       * field of the persisted attempt may contain the phone number, and the
       * whole serialised document is searched rather than the fields somebody
       * remembered to check.
       *
       * The paired assertion — that the bridge DID receive it — is what stops
       * this passing because the value never left the client.
       */
      const started = await request(appWithAuth())
        .post("/api/bridges/networks/telegram/link")
        .send({ flowId: "phone" });
      const linkId = started.body.data.linkId as string;

      await request(appWithAuth())
        .post(`/api/bridges/links/${linkId}/submit`)
        .send({ values: { "fi.mau.telegram.login.phone_number": "+34600111222" } });

      const step = bridge.calls.find((call) => call.path.includes("/login/step/"));
      expect(step?.body).toMatchObject({
        "fi.mau.telegram.login.phone_number": "+34600111222",
      });

      const stored = await BridgeLinkSession.findOne({
        linkId,
      }).lean<LeanBridgeLinkSession>();
      expect(JSON.stringify(stored)).not.toContain("+34600111222");
      expect(JSON.stringify(stored)).not.toContain("600111222");
    });
  });

  describe("finishing an attempt", () => {
    it("records the account the bridge created", async () => {
      bridge.nextStep = {
        type: "complete",
        step_id: "fi.mau.telegram.login.complete",
        complete: { user_login_id: "remote-login-1" },
      };

      const started = await request(appWithAuth())
        .post("/api/bridges/networks/telegram/link")
        .send({ flowId: "phone" });
      const linkId = started.body.data.linkId as string;

      const completed = await request(appWithAuth())
        .post(`/api/bridges/links/${linkId}/submit`)
        .send({ values: { "fi.mau.telegram.login.phone_number": "+34600111222" } });

      expect(completed.status).toBe(200);
      expect(completed.body.data.account).toMatchObject({
        network: "telegram",
        remoteName: "Ada",
        state: "connecting",
      });

      const account = await BridgeAccount.findOne({ oxyUserId: USER }).lean();
      expect(account?.remoteLoginId).toBe("remote-login-1");
      expect(account?.spaceRoomId).toBe("!space:allo.you");
    });

    it("refuses a step type it cannot present, instead of drawing nothing", async () => {
      /**
       * §5.2: `cookies`, `client_http` and `webauthn` belong to networks this
       * deployment cannot enable and to UI that does not exist. A step Allo
       * cannot render has to fail traceably — the alternative is a login screen
       * that hangs with nothing on it and no way to say why.
       */
      bridge.nextStep = { type: "webauthn", step_id: "fi.mau.whatsapp.login.passkey" };

      const started = await request(appWithAuth())
        .post("/api/bridges/networks/telegram/link")
        .send({ flowId: "phone" });
      const linkId = started.body.data.linkId as string;

      const response = await request(appWithAuth())
        .post(`/api/bridges/links/${linkId}/submit`)
        .send({ values: {} });

      expect(response.status).toBe(501);
      expect(response.body.error).toBe("unsupported_step");
    });
  });

  describe("unlinking", () => {
    it("keeps the proxy lease so re-linking returns to the same geography", async () => {
      /**
       * §5.2 and §8.3 rule 3 are explicit that `DELETE /accounts/:id` does NOT
       * free the lease. Releasing it here would hand the user a different exit
       * country the next time they linked — which is precisely the between-session
       * jump the whole design exists to avoid.
       */
      const account = await BridgeAccount.create({
        oxyUserId: USER,
        network: "telegram",
        remoteLoginId: "remote-login-1",
        state: "connected",
        linkedAt: new Date(),
        lastStateAt: new Date(),
      });
      await BridgeProxyLease.create({
        oxyUserId: USER,
        network: "telegram",
        provider: "provider-a",
        countryCode: "ES",
        sessionSeed: "seed-abc",
        state: "active",
        rotations: [],
      });

      const response = await request(appWithAuth()).delete(
        `/api/bridges/accounts/${account._id.toString()}`,
      );

      expect(response.status).toBe(200);
      expect(await BridgeAccount.countDocuments({})).toBe(0);

      const lease = await BridgeProxyLease.findOne({ oxyUserId: USER }).lean();
      expect(lease?.sessionSeed).toBe("seed-abc");
      expect(lease?.countryCode).toBe("ES");
    });

    it("does not let one user unlink another's account", async () => {
      const account = await BridgeAccount.create({
        oxyUserId: USER,
        network: "telegram",
        remoteLoginId: "remote-login-1",
        state: "connected",
        linkedAt: new Date(),
        lastStateAt: new Date(),
      });

      const response = await request(appWithAuth())
        .delete(`/api/bridges/accounts/${account._id.toString()}`)
        .set("x-test-user", OTHER_USER);

      expect(response.status).toBe(404);
      expect(await BridgeAccount.countDocuments({})).toBe(1);
    });
  });

  describe("listing accounts", () => {
    it("returns only the caller's, and never the bridge's free-text message", async () => {
      /**
       * `rawState.message` is written for an operator, changes between bridge
       * releases and is the field most likely to name an internal host. The
       * machine-readable `error` code is surfaced instead, because the app can
       * act on that one.
       */
      await BridgeAccount.create({
        oxyUserId: USER,
        network: "telegram",
        remoteLoginId: "remote-login-1",
        state: "action_required",
        linkedAt: new Date(),
        lastStateAt: new Date(),
        rawState: {
          stateEvent: "BAD_CREDENTIALS",
          error: "FI.MAU.TELEGRAM.AUTH_KEY_UNREGISTERED",
          message: "session terminated on host bridge-telegram-7.internal",
          at: new Date(),
        },
      });
      await BridgeAccount.create({
        oxyUserId: OTHER_USER,
        network: "telegram",
        remoteLoginId: "remote-login-2",
        state: "connected",
        linkedAt: new Date(),
        lastStateAt: new Date(),
      });

      const response = await request(appWithAuth()).get("/api/bridges/accounts");

      expect(response.body.data.accounts).toHaveLength(1);
      expect(response.body.data.accounts[0].errorCode).toBe(
        "FI.MAU.TELEGRAM.AUTH_KEY_UNREGISTERED",
      );
      expect(JSON.stringify(response.body)).not.toContain("bridge-telegram-7.internal");
    });
  });
});
