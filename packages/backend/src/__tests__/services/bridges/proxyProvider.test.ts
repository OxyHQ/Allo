import http from "http";
import net from "net";
import type { AddressInfo } from "net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { resetBridgesConfigForTests } from "../../../config/bridges";
import {
  countryFromDialingPrefix,
} from "../../../services/bridges/proxy/dialingCodes";
import { resolveLeaseCountry } from "../../../services/bridges/proxy/countryResolution";
import {
  createTemplateProxyProvider,
  ProxyProviderError,
  ProxyVerificationUnavailableError,
} from "../../../services/bridges/proxy/proxyProvider";

/**
 * The proxy provider itself: how a URL is composed, and whether the exit
 * verification actually goes THROUGH the proxy (docs/matrix/bridges.md §8.2).
 *
 * The verification tests run against a real HTTP `CONNECT` proxy and a real echo
 * server, both local. That matters because the claim being made is a claim about
 * transport: "the echo answer came back through the proxy, carrying the
 * credentials we composed". A mocked fetch would agree with that claim while the
 * request went out directly — which is precisely the fault §8.3 rule 5 exists to
 * catch, and it would be catching it with a test that cannot see it.
 */

interface StubProxy {
  readonly port: number;
  /** The `Proxy-Authorization` values the proxy actually received. */
  readonly credentials: string[];
  close(): Promise<void>;
}

/** A minimal HTTP CONNECT proxy that tunnels to wherever it is asked. */
async function startStubProxy(): Promise<StubProxy> {
  const credentials: string[] = [];

  const server = net.createServer((client) => {
    client.once("data", (chunk: Buffer) => {
      const preamble = chunk.toString("latin1");
      const [requestLine, ...headerLines] = preamble.split("\r\n");
      const authorization = headerLines.find((line) =>
        line.toLowerCase().startsWith("proxy-authorization:"),
      );
      if (authorization) {
        const encoded = authorization.slice(authorization.indexOf(":") + 1).trim();
        credentials.push(
          Buffer.from(encoded.replace(/^Basic\s+/i, ""), "base64").toString("utf8"),
        );
      }

      const authority = requestLine.split(" ")[1] ?? "";
      const separator = authority.lastIndexOf(":");
      const upstream = net.connect(
        { host: authority.slice(0, separator), port: Number(authority.slice(separator + 1)) },
        () => {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          client.pipe(upstream);
          upstream.pipe(client);
        },
      );
      upstream.on("error", () => client.destroy());
    });
    client.on("error", () => client.destroy());
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as AddressInfo).port,
    credentials,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface StubEcho {
  readonly url: string;
  body: string;
  status: number;
  close(): Promise<void>;
}

async function startStubEcho(): Promise<StubEcho> {
  const state = {
    body: JSON.stringify({ ip: "203.0.113.7", country: "ES" }),
    status: 200,
  };

  const server = http.createServer((_request, response) => {
    response.writeHead(state.status, { "content-type": "application/json" });
    response.end(state.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/whoami`,
    get body() {
      return state.body;
    },
    set body(value: string) {
      state.body = value;
    },
    get status() {
      return state.status;
    },
    set status(value: number) {
      state.status = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

const LEASE = { countryCode: "ES", sessionSeed: "seed-abc123" };

describe("composing a proxy URL", () => {
  const provider = createTemplateProxyProvider({
    providerId: "provider-a",
    gateway: "http://gateway.example:8000",
    usernameTemplate: "acct-country-{country}-session-{session}",
    password: "p@ss word/1",
  });

  it("puts the lease's country and session into the username", () => {
    const url = new URL(provider.composeUrl(LEASE));

    expect(decodeURIComponent(url.username)).toBe("acct-country-es-session-seed-abc123");
    expect(url.host).toBe("gateway.example:8000");
  });

  it("percent-encodes credentials so punctuation cannot break the URL", () => {
    /**
     * Provider passwords contain `@`, `/` and spaces routinely. Unencoded, an
     * `@` re-splits the authority and the composed URL points somewhere else
     * entirely — a proxy URL that parses fine and connects to the wrong host.
     */
    const url = new URL(provider.composeUrl(LEASE));

    expect(decodeURIComponent(url.password)).toBe("p@ss word/1");
    expect(url.hostname).toBe("gateway.example");
  });

  it("gives two sessions in the same country different usernames", () => {
    /**
     * §8.3 rule 7 at the URL layer: if the seed did not reach the username, two
     * users in Spain would share one provider session and one exit address —
     * which is the correlation the whole per-user proxy design is bought to
     * avoid, and it would look completely healthy.
     */
    const mine = provider.composeUrl(LEASE);
    const theirs = provider.composeUrl({ countryCode: "ES", sessionSeed: "seed-xyz789" });

    expect(mine).not.toBe(theirs);
  });

  it("refuses to compose a URL for a country the provider does not sell", () => {
    const restricted = createTemplateProxyProvider({
      providerId: "provider-a",
      gateway: "gateway.example:8000",
      usernameTemplate: "acct-country-{country}-session-{session}",
      password: "pw",
      countries: ["ES", "PT"],
    });

    expect(restricted.supportsCountry("ES")).toBe(true);
    expect(restricted.supportsCountry("DE")).toBe(false);
    expect(() => restricted.composeUrl({ countryCode: "DE", sessionSeed: "s" })).toThrow(
      ProxyProviderError,
    );
  });

  it("treats an absent country list as unknown coverage, not empty coverage", () => {
    /**
     * A provider's coverage list is theirs, not ours. Reading "no list" as "no
     * countries" would make an unconfigured-but-valid deployment refuse every
     * lease, and the exit verification is what catches a country they do not
     * actually serve.
     */
    expect(provider.supportsCountry("DE")).toBe(true);
    expect(provider.supportsCountry("not-a-country")).toBe(false);
  });

  it("refuses a SOCKS5 gateway at construction rather than at verification time", () => {
    /**
     * The exit check tunnels with HTTP `CONNECT`, which SOCKS5 does not speak.
     * Accepting such a gateway would produce a deployment where composing a URL
     * works and verifying it never can — and an exit that cannot be verified is
     * one that egresses from the wrong country undetected.
     */
    expect(() =>
      createTemplateProxyProvider({
        providerId: "provider-a",
        gateway: "socks5://gateway.example:1080",
        usernameTemplate: "acct-country-{country}-session-{session}",
        password: "pw",
      }),
    ).toThrow(/cannot be exit-verified/);
  });

  it("refuses a gateway without a port", () => {
    expect(() =>
      createTemplateProxyProvider({
        providerId: "provider-a",
        gateway: "gateway.example",
        usernameTemplate: "acct-country-{country}-session-{session}",
        password: "pw",
      }),
    ).toThrow(/must include a port/);
  });
});

describe("verifying where the proxy comes out", () => {
  let proxy: StubProxy;
  let echo: StubEcho;

  beforeAll(async () => {
    proxy = await startStubProxy();
    echo = await startStubEcho();
  });

  afterAll(async () => {
    await proxy.close();
    await echo.close();
  });

  afterEach(() => {
    echo.body = JSON.stringify({ ip: "203.0.113.7", country: "ES" });
    echo.status = 200;
    resetBridgesConfigForTests();
  });

  function providerThrough(overrides: { echoUrl?: string } = {}) {
    return createTemplateProxyProvider({
      providerId: "provider-a",
      gateway: `http://127.0.0.1:${proxy.port}`,
      usernameTemplate: "acct-country-{country}-session-{session}",
      password: "a-proxy-password",
      ...("echoUrl" in overrides ? { echoUrl: overrides.echoUrl } : { echoUrl: echo.url }),
    });
  }

  it("reads the echo answer back through the tunnel", async () => {
    const observation = await providerThrough().verifyExit(LEASE);

    expect(observation).toEqual({ ip: "203.0.113.7", country: "ES" });
  });

  it("presents the composed credentials to the proxy", async () => {
    /**
     * The assertion that proves the request went THROUGH the proxy rather than
     * around it, and that the country and session made it into the credentials
     * the provider will key the session on. Without this, an implementation that
     * ignored the proxy entirely and fetched the echo directly would return the
     * same observation and pass the test above.
     */
    const before = proxy.credentials.length;

    await providerThrough().verifyExit({ countryCode: "PT", sessionSeed: "seed-999" });

    const received = proxy.credentials.slice(before);
    expect(received).toHaveLength(1);
    expect(received[0]).toContain("acct-country-pt-session-seed-999");
    expect(received[0]).toContain("a-proxy-password");
  });

  it("uppercases the country the echo endpoint reported", async () => {
    echo.body = JSON.stringify({ ip: "203.0.113.7", country: "es" });

    await expect(providerThrough().verifyExit(LEASE)).resolves.toMatchObject({
      country: "ES",
    });
  });

  it("refuses an echo answer that is not JSON", async () => {
    echo.body = "<html>captive portal</html>";

    await expect(providerThrough().verifyExit(LEASE)).rejects.toThrow(/did not return JSON/);
  });

  it("refuses an echo answer missing the fields it is read for", async () => {
    /**
     * A body that parses but says nothing useful must not be read as a
     * successful verification — that would be rule 5 passing on a technicality
     * while checking nothing.
     */
    echo.body = JSON.stringify({ result: "ok" });

    await expect(providerThrough().verifyExit(LEASE)).rejects.toThrow(/must return/);
  });

  it("refuses a non-2xx answer from the echo endpoint", async () => {
    echo.status = 502;

    await expect(providerThrough().verifyExit(LEASE)).rejects.toThrow(/answered 502/);
  });

  it("reports that verification is unavailable when no echo endpoint is configured", async () => {
    /**
     * A distinct error type, because the caller treats it differently: a
     * deployment with no echo endpoint proceeds with a warning, while every
     * other verification failure refuses to connect.
     */
    await expect(
      providerThrough({ echoUrl: undefined }).verifyExit(LEASE),
    ).rejects.toBeInstanceOf(ProxyVerificationUnavailableError);
  });
});

describe("deciding which country to freeze", () => {
  it("prefers the profile, then the phone, then the request", () => {
    expect(
      resolveLeaseCountry({
        profileCountry: "PT",
        phoneNumber: "+34600111222",
        requestCountry: "DE",
      }),
    ).toEqual({ countryCode: "PT", source: "profile" });

    expect(
      resolveLeaseCountry({ phoneNumber: "+34600111222", requestCountry: "DE" }),
    ).toEqual({ countryCode: "ES", source: "phone" });

    expect(resolveLeaseCountry({ requestCountry: "DE" })).toEqual({
      countryCode: "DE",
      source: "request",
    });
  });

  it("answers nothing rather than guessing", () => {
    expect(resolveLeaseCountry({})).toBeUndefined();
    expect(resolveLeaseCountry({ profileCountry: "Spain" })).toBeUndefined();
  });

  it("skips a source that cannot be read and falls through to the next", () => {
    /**
     * A malformed profile country must not consume the decision. If it did, a
     * user whose profile says "Spain" would get no lease at all, when their
     * phone number said `+34` all along.
     */
    expect(
      resolveLeaseCountry({ profileCountry: "Spain", phoneNumber: "+34600111222" }),
    ).toEqual({ countryCode: "ES", source: "phone" });
  });
});

describe("reading a country off a phone number", () => {
  it("resolves unambiguous international prefixes", () => {
    expect(countryFromDialingPrefix("+34 600 111 222")).toBe("ES");
    expect(countryFromDialingPrefix("+351912345678")).toBe("PT");
    expect(countryFromDialingPrefix("+49 (30) 123456")).toBe("DE");
  });

  it("prefers the longest matching prefix", () => {
    /**
     * `+350` is Gibraltar and `+35` is nothing. A shortest-match implementation
     * would answer with whatever two-digit code happened to be scanned first.
     */
    expect(countryFromDialingPrefix("+35020012345")).toBe("GI");
    expect(countryFromDialingPrefix("+35112345678")).toBe("PT");
  });

  it.each(["+12125550100", "+79161234567", "+590590123456"])(
    "answers nothing for the shared code in %s",
    (number) => {
      /**
       * `+1` covers the US, Canada and about twenty Caribbean countries; `+7`
       * covers Russia and Kazakhstan; `+590` covers three territories. The
       * country is FROZEN onto the lease and never recalculated, so a wrong
       * guess is a user permanently egressing from the wrong place. Falling
       * through to the next source is safe; guessing is not.
       */
      expect(countryFromDialingPrefix(number)).toBeUndefined();
    },
  );

  it("answers nothing for a national number with no country in it", () => {
    expect(countryFromDialingPrefix("600111222")).toBeUndefined();
    expect(countryFromDialingPrefix("0034600111222")).toBeUndefined();
  });

  it("answers nothing for something that is not a phone number", () => {
    expect(countryFromDialingPrefix("+not-a-number")).toBeUndefined();
    expect(countryFromDialingPrefix("")).toBeUndefined();
  });
});
