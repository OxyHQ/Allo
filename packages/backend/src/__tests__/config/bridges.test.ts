import { afterEach, describe, expect, it } from "vitest";

import {
  BRIDGE_NETWORK_CATALOG,
  enabledBridgeNetwork,
  enabledBridgeNetworks,
  loadBridgesConfig,
  resetBridgesConfigForTests,
} from "../../config/bridges";

/**
 * The per-network flag (docs/matrix/bridges.md §9).
 *
 * The flag's whole job is to make one specific accident impossible: WhatsApp or
 * Meta reachable without a per-user proxy, which means every user egressing from
 * one datacentre address, perfectly correlated for banning. §9.2 says that must
 * be impossible "por construcción, no por disciplina", and the construction is
 * that a deployment asking for such a network DOES NOT BOOT.
 *
 * So these tests assert on `loadBridgesConfig` throwing — not on a route
 * returning 404. The 404 is downstream of this; if this passes, there is no
 * running process in which the route could answer anything else.
 *
 * Each "refuses X" test is paired with a test that the same configuration
 * PLUS the missing piece is accepted. Without those pairs, a `loadBridgesConfig`
 * that threw unconditionally — or one that rejected every configuration for an
 * unrelated reason — would satisfy the whole file.
 */

const SECRET = "a-shared-secret-that-is-long-enough-32";
const AS_TOKEN = "an-as-token-that-is-also-long-enough-32";

/** A complete, valid single-network environment: the baseline every case mutates. */
function telegramEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ALLO_BRIDGES_ENABLED: "telegram",
    ALLO_MATRIX_SERVER_NAME: "allo.you",
    ALLO_BRIDGE_TELEGRAM_BASE_URL: "http://allo-bridge-telegram:29317",
    ALLO_BRIDGE_TELEGRAM_SHARED_SECRET: SECRET,
    ALLO_BRIDGE_TELEGRAM_AS_TOKEN: AS_TOKEN,
    ...overrides,
  };
}

/** A complete proxy provider. `{country}` and `{session}` are load-bearing. */
const PROXY_ENV = {
  ALLO_BRIDGE_PROXY_PROVIDER: "provider-a",
  ALLO_BRIDGE_PROXY_GATEWAY: "http://gateway.example:8000",
  ALLO_BRIDGE_PROXY_USERNAME_TEMPLATE: "acct-country-{country}-session-{session}",
  ALLO_BRIDGE_PROXY_PASSWORD: "a-proxy-password",
};

function whatsappEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    ALLO_BRIDGES_ENABLED: "whatsapp",
    ALLO_MATRIX_SERVER_NAME: "allo.you",
    ALLO_BRIDGE_WHATSAPP_BASE_URL: "http://allo-bridge-whatsapp:29318",
    ALLO_BRIDGE_WHATSAPP_SHARED_SECRET: SECRET,
    ALLO_BRIDGE_WHATSAPP_AS_TOKEN: AS_TOKEN,
    ...overrides,
  };
}

/** The messages zod collected, flattened — assertions name the cause, not just "it threw". */
function issuesOf(load: () => unknown): string[] {
  try {
    load();
  } catch (error) {
    const issues: unknown = Reflect.get(Object(error), "issues");
    if (Array.isArray(issues)) {
      return issues.map((issue: unknown) => {
        const path: unknown = Reflect.get(Object(issue), "path");
        const message: unknown = Reflect.get(Object(issue), "message");
        return `${Array.isArray(path) ? path.join(".") : ""}: ${String(message)}`;
      });
    }
    return [String(error)];
  }
  throw new Error("expected loadBridgesConfig to reject this environment, but it succeeded");
}

afterEach(() => {
  resetBridgesConfigForTests();
});

describe("the network catalogue is not the flag", () => {
  it("does not enable a network merely by knowing about it", () => {
    /**
     * The catalogue lists six networks. An empty `ALLO_BRIDGES_ENABLED` must
     * produce none of them — otherwise "adding a row enables nothing" is false
     * and every other guarantee here is decoration.
     */
    const config = loadBridgesConfig({ ALLO_BRIDGES_ENABLED: "" });

    expect(Object.keys(BRIDGE_NETWORK_CATALOG)).toHaveLength(6);
    expect(config.networks.size).toBe(0);
    expect(config.enabled).toBe(false);
  });

  it("enables only what is listed, even when the others are fully configured", () => {
    /**
     * The discriminating case: Slack's three variables are all present and
     * correct, and Slack is still absent because it is not in the list. Without
     * this, "enabled" could be implemented as "has variables" and every test
     * above would still pass.
     */
    const config = loadBridgesConfig(
      telegramEnv({
        ALLO_BRIDGE_SLACK_BASE_URL: "http://allo-bridge-slack:29319",
        ALLO_BRIDGE_SLACK_SHARED_SECRET: SECRET,
        ALLO_BRIDGE_SLACK_AS_TOKEN: AS_TOKEN,
      }),
    );

    expect([...config.networks.keys()]).toEqual(["telegram"]);
  });
});

describe("half a configuration is refused at boot", () => {
  it.each(["BASE_URL", "SHARED_SECRET", "AS_TOKEN"] as const)(
    "refuses telegram without %s, naming the variable",
    (suffix) => {
      const env = telegramEnv({ [`ALLO_BRIDGE_TELEGRAM_${suffix}`]: undefined });

      const issues = issuesOf(() => loadBridgesConfig(env));

      expect(issues.join("\n")).toContain(`ALLO_BRIDGE_TELEGRAM_${suffix}`);
      expect(issues.join("\n")).toContain("ALLO_BRIDGES_ENABLED");
    },
  );

  it("accepts the same environment once all three are present", () => {
    /**
     * The vacuity guard for the three above. They are satisfied by ANY refusal,
     * including one caused by something else entirely in the fixture.
     */
    const config = loadBridgesConfig(telegramEnv());

    const telegram = config.networks.get("telegram");
    expect(telegram?.baseUrl).toBe("http://allo-bridge-telegram:29317");
    expect(telegram?.sharedSecret).toBe(SECRET);
    expect(telegram?.asToken).toBe(AS_TOKEN);
  });

  it("refuses a shared secret shorter than 32 characters", () => {
    /**
     * §4.1 asks for 32+, and the reason is what the secret DOES: it lets its
     * holder act as any user of that bridge (§5.1). A short secret passes every
     * functional test and is brute-forceable — the combination that never gets
     * noticed.
     */
    const issues = issuesOf(() =>
      loadBridgesConfig(telegramEnv({ ALLO_BRIDGE_TELEGRAM_SHARED_SECRET: "short" })),
    );

    expect(issues.join("\n")).toContain("at least 32 characters");
  });

  it("refuses a base URL carrying a path", () => {
    /**
     * The origin is concatenated with provisioning paths. A stray path produces
     * 404s from the bridge that everyone reads as "the bridge is down".
     */
    const issues = issuesOf(() =>
      loadBridgesConfig(
        telegramEnv({ ALLO_BRIDGE_TELEGRAM_BASE_URL: "http://bridge:29317/api" }),
      ),
    );

    expect(issues.join("\n")).toContain("without credentials, path, query or fragment");
  });

  it("refuses a network nobody has heard of", () => {
    const issues = issuesOf(() =>
      loadBridgesConfig(telegramEnv({ ALLO_BRIDGES_ENABLED: "telegram,signal" })),
    );

    expect(issues.join("\n")).toContain('unknown network "signal"');
  });

  it("refuses to enable anything without a Matrix server name", () => {
    /**
     * Every provisioning call is made AS a specific MXID (§5.1), and the MXID
     * cannot be built without the server name. Without this check the failure
     * lands on the first link attempt instead of at boot.
     */
    const issues = issuesOf(() =>
      loadBridgesConfig(telegramEnv({ ALLO_MATRIX_SERVER_NAME: undefined })),
    );

    expect(issues.join("\n")).toContain("ALLO_MATRIX_SERVER_NAME");
  });

  it("refuses a server name given as a URL", () => {
    const issues = issuesOf(() =>
      loadBridgesConfig(telegramEnv({ ALLO_MATRIX_SERVER_NAME: "https://allo.you/" })),
    );

    expect(issues.join("\n")).toContain("Matrix server name");
  });
});

describe("a network that needs a proxy cannot exist without a provider", () => {
  it("refuses WhatsApp when no proxy provider is configured", () => {
    /**
     * THE test. §9.2 rule 2, and the reason the flag exists at all.
     *
     * Everything else about WhatsApp in this environment is correct — base URL,
     * shared secret, as_token, server name. The only thing missing is the proxy
     * provider, and that alone must stop the process from starting.
     */
    const issues = issuesOf(() => loadBridgesConfig(whatsappEnv()));

    expect(issues.join("\n")).toContain("ALLO_BRIDGE_PROXY_PROVIDER");
    expect(issues.join("\n")).toContain("egress from the same datacentre address");
  });

  it.each(["instagram", "messenger"] as const)(
    "refuses %s for the same reason",
    (network) => {
      const issues = issuesOf(() =>
        loadBridgesConfig({
          ALLO_BRIDGES_ENABLED: network,
          ALLO_MATRIX_SERVER_NAME: "allo.you",
          [`ALLO_BRIDGE_${network.toUpperCase()}_BASE_URL`]: "http://bridge:29320",
          [`ALLO_BRIDGE_${network.toUpperCase()}_SHARED_SECRET`]: SECRET,
          [`ALLO_BRIDGE_${network.toUpperCase()}_AS_TOKEN`]: AS_TOKEN,
        }),
      );

      expect(issues.join("\n")).toContain("ALLO_BRIDGE_PROXY_PROVIDER");
    },
  );

  it("accepts WhatsApp once a complete provider is configured", () => {
    /**
     * The vacuity guard, and the one that proves the refusal above is ABOUT the
     * proxy. Without it, a `loadBridgesConfig` that rejected WhatsApp for any
     * reason at all — or rejected it unconditionally — would look identical.
     *
     * It also pins the intended behaviour: the flag is a flag, not a permanent
     * ban. Turning these networks on is a deliberate act with a prerequisite,
     * and the prerequisite is the proxy.
     */
    const config = loadBridgesConfig(whatsappEnv(PROXY_ENV));

    expect(config.networks.get("whatsapp")?.requiresProxy).toBe(true);
    expect(config.proxy?.providerId).toBe("provider-a");
  });

  it("does not accept a provider whose username template cannot encode the country", () => {
    /**
     * Half a proxy provider is worse than none, and worse in a specific way: a
     * template without `{country}` composes a URL the provider ACCEPTS, and then
     * egresses from wherever it feels like. The lease would say Spain, the
     * traffic would come from anywhere, and nothing would report a problem.
     *
     * So an incomplete provider must not count as a provider — which means
     * WhatsApp must still be refused.
     */
    const issues = issuesOf(() =>
      loadBridgesConfig(
        whatsappEnv({
          ...PROXY_ENV,
          ALLO_BRIDGE_PROXY_USERNAME_TEMPLATE: "acct-session-{session}",
        }),
      ),
    );

    expect(issues.join("\n")).toContain("ALLO_BRIDGE_PROXY_PROVIDER");
  });

  it("does not accept a provider whose username template cannot encode the session", () => {
    /**
     * The other half. Without `{session}`, every user of the deployment shares
     * one proxy session — which is §8.3 rule 7 broken silently, and the exact
     * correlation per-user proxies are bought to prevent.
     */
    const issues = issuesOf(() =>
      loadBridgesConfig(
        whatsappEnv({
          ...PROXY_ENV,
          ALLO_BRIDGE_PROXY_USERNAME_TEMPLATE: "acct-country-{country}",
        }),
      ),
    );

    expect(issues.join("\n")).toContain("ALLO_BRIDGE_PROXY_PROVIDER");
  });

  it.each(["ALLO_BRIDGE_PROXY_GATEWAY", "ALLO_BRIDGE_PROXY_PASSWORD"] as const)(
    "does not accept a provider missing %s",
    (variable) => {
      const issues = issuesOf(() =>
        loadBridgesConfig(whatsappEnv({ ...PROXY_ENV, [variable]: undefined })),
      );

      expect(issues.join("\n")).toContain("ALLO_BRIDGE_PROXY_PROVIDER");
    },
  );

  it("leaves a proxy-free network alone when no provider is configured", () => {
    /**
     * The proxy requirement must attach to the networks that declare it and to
     * no others. A check that refused every network without a provider would
     * pass every test above and take Telegram down with it.
     */
    const config = loadBridgesConfig(telegramEnv());

    expect(config.networks.get("telegram")?.requiresProxy).toBe(false);
    expect(config.proxy).toBeUndefined();
  });
});

describe("a network whose protocol has no client is refused", () => {
  it("refuses Discord, which speaks the legacy provisioning API", () => {
    /**
     * §3.2: `mautrix-discord` is not bridgev2 and exposes a different `/v1`
     * surface that needs its own adapter. This build has no such adapter.
     *
     * Enabling it anyway would publish Discord in `GET /api/bridges/networks` —
     * the catalogue the app renders — and every login attempt would fail at the
     * first call. A network in the picker that cannot be linked is worse than a
     * network that is not there.
     */
    const issues = issuesOf(() =>
      loadBridgesConfig({
        ALLO_BRIDGES_ENABLED: "discord",
        ALLO_MATRIX_SERVER_NAME: "allo.you",
        ALLO_BRIDGE_DISCORD_BASE_URL: "http://allo-bridge-discord:29319",
        ALLO_BRIDGE_DISCORD_SHARED_SECRET: SECRET,
        ALLO_BRIDGE_DISCORD_AS_TOKEN: AS_TOKEN,
      }),
    );

    expect(issues.join("\n")).toContain("legacy provisioning protocol");
    expect(BRIDGE_NETWORK_CATALOG.discord.architecture).toBe("legacy");
  });

  it("accepts a bridgev2 network with the identical shape", () => {
    /** The vacuity guard: it is the ARCHITECTURE that is refused, not the fixture. */
    const config = loadBridgesConfig({
      ALLO_BRIDGES_ENABLED: "slack",
      ALLO_MATRIX_SERVER_NAME: "allo.you",
      ALLO_BRIDGE_SLACK_BASE_URL: "http://allo-bridge-slack:29319",
      ALLO_BRIDGE_SLACK_SHARED_SECRET: SECRET,
      ALLO_BRIDGE_SLACK_AS_TOKEN: AS_TOKEN,
    });

    expect(config.networks.get("slack")?.architecture).toBe("bridgev2");
  });
});

describe("the single gate every route goes through", () => {
  it("reports a disabled network as absent, exactly like an unknown one", () => {
    /**
     * `enabledBridgeNetwork` returning `undefined` is what produces §9.2 rule
     * 3's 404. The point is that the caller CANNOT tell the cases apart: a
     * disabled network, a half-configured one and a network that never existed
     * all look identical, so the app cannot enumerate the roadmap by probing
     * ids.
     */
    process.env.ALLO_BRIDGES_ENABLED = "telegram";
    process.env.ALLO_MATRIX_SERVER_NAME = "allo.you";
    process.env.ALLO_BRIDGE_TELEGRAM_BASE_URL = "http://allo-bridge-telegram:29317";
    process.env.ALLO_BRIDGE_TELEGRAM_SHARED_SECRET = SECRET;
    process.env.ALLO_BRIDGE_TELEGRAM_AS_TOKEN = AS_TOKEN;
    resetBridgesConfigForTests();

    try {
      expect(enabledBridgeNetwork("telegram")?.id).toBe("telegram");
      expect(enabledBridgeNetwork("whatsapp")).toBeUndefined();
      expect(enabledBridgeNetwork("slack")).toBeUndefined();
      expect(enabledBridgeNetwork("not-a-network")).toBeUndefined();
      expect(enabledBridgeNetworks().map((network) => network.id)).toEqual(["telegram"]);
    } finally {
      delete process.env.ALLO_BRIDGES_ENABLED;
      delete process.env.ALLO_MATRIX_SERVER_NAME;
      delete process.env.ALLO_BRIDGE_TELEGRAM_BASE_URL;
      delete process.env.ALLO_BRIDGE_TELEGRAM_SHARED_SECRET;
      delete process.env.ALLO_BRIDGE_TELEGRAM_AS_TOKEN;
      resetBridgesConfigForTests();
    }
  });

  it("returns enabled networks in catalogue order rather than in listing order", () => {
    /**
     * The catalogue's order is stable across deployments; the order somebody
     * typed into an environment variable is not. A user-visible list that
     * reshuffles because an operator reordered a comma-separated string is a
     * bug nobody will ever file.
     */
    const config = loadBridgesConfig({
      ALLO_BRIDGES_ENABLED: "slack,telegram",
      ALLO_MATRIX_SERVER_NAME: "allo.you",
      ALLO_BRIDGE_SLACK_BASE_URL: "http://allo-bridge-slack:29319",
      ALLO_BRIDGE_SLACK_SHARED_SECRET: SECRET,
      ALLO_BRIDGE_SLACK_AS_TOKEN: AS_TOKEN,
      ALLO_BRIDGE_TELEGRAM_BASE_URL: "http://allo-bridge-telegram:29317",
      ALLO_BRIDGE_TELEGRAM_SHARED_SECRET: SECRET,
      ALLO_BRIDGE_TELEGRAM_AS_TOKEN: AS_TOKEN,
    });

    expect([...config.networks.keys()]).toEqual(["telegram", "slack"]);
  });
});
