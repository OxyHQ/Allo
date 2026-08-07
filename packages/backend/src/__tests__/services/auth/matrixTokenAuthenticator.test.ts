import { beforeEach, describe, expect, it } from "vitest";

import { loadMatrixAuthConfig, type MatrixAuthConfig } from "../../../config/matrixAuth";
import {
  MasUnreachableError,
  type HttpFetch,
  type MasIntrospectionResponse as Introspection,
} from "../../../services/auth/masIntrospection";
import {
  createMatrixTokenAuthenticator,
  evaluateIntrospection,
} from "../../../services/auth/matrixTokenAuthenticator";
import { BRIDGE_NETWORK_IDS } from "../../../config/bridges";

/**
 * What an introspection answer MEANS, and how long it may be remembered.
 *
 * Split in two on purpose. {@link evaluateIntrospection} is pure, so every rule
 * below is one call with no HTTP and no clock; the cache tests then drive the
 * real authenticator with a fake `fetch` and a fake clock, and count round
 * trips, which is the only way to prove a bound rather than assert it.
 */

const ISSUER = "https://auth.allo.you/";
const CLIENT_SECRET = "0123456789abcdef0123456789abcdef";
const OXY_USER_ID = "507f1f77bcf86cd799439011";
const MATRIX_SCOPE = "urn:matrix:org.matrix.msc2967.client:api:*";
const NOW_SECONDS = 1_800_000_000;

function config(overrides: Record<string, string> = {}): MatrixAuthConfig {
  return loadMatrixAuthConfig({
    ALLO_MAS_ISSUER: ISSUER,
    ALLO_MAS_INTROSPECTION_URL: "https://auth.allo.you/oauth2/introspect",
    ALLO_MAS_INTROSPECTION_CLIENT_ID: "allo-backend",
    ALLO_MAS_INTROSPECTION_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  });
}

/** A live, ordinary Matrix session for an ordinary Allo account. */
function liveToken(overrides: Partial<Introspection> = {}): Introspection {
  return {
    active: true,
    scope: `openid ${MATRIX_SCOPE} urn:matrix:org.matrix.msc2967.client:device:ABCDEFGH`,
    username: OXY_USER_ID,
    client_id: "01HXYZDYNAMICALLYREGISTERED",
    token_type: "access_token",
    device_id: "ABCDEFGH",
    exp: NOW_SECONDS + 3600,
    ...overrides,
  };
}

function evaluate(
  response: Introspection,
  configuration: MatrixAuthConfig = config(),
): ReturnType<typeof evaluateIntrospection> {
  return evaluateIntrospection(response, configuration, NOW_SECONDS);
}

describe("what an introspection answer means", () => {
  it("accepts a live Matrix session and names the Oxy account", () => {
    expect(evaluate(liveToken())).toEqual({
      outcome: "accepted",
      oxyUserId: OXY_USER_ID,
      deviceId: "ABCDEFGH",
    });
  });

  it("accepts a session MAS reports without a device", () => {
    const result = evaluate(liveToken({ device_id: undefined }));

    expect(result).toEqual({ outcome: "accepted", oxyUserId: OXY_USER_ID, deviceId: undefined });
  });

  it("refuses an inactive token", () => {
    expect(evaluate({ active: false })).toEqual({ outcome: "refused", reason: "inactive" });
  });

  it("refuses an inactive token even when every other field looks right", () => {
    /**
     * MAS answers a revoked token with a bare `{"active": false}`, but an
     * authorization server is free to echo the rest back, and a check that ran
     * the other rules first and forgot this one would accept a signed-out
     * device.
     */
    expect(evaluate(liveToken({ active: false }))).toEqual({
      outcome: "refused",
      reason: "inactive",
    });
  });

  it("refuses a token that has already expired", () => {
    expect(evaluate(liveToken({ exp: NOW_SECONDS - 1 }))).toEqual({
      outcome: "refused",
      reason: "expired",
    });
  });

  it("refuses a token at the exact second it expires", () => {
    expect(evaluate(liveToken({ exp: NOW_SECONDS }))).toEqual({
      outcome: "refused",
      reason: "expired",
    });
  });

  it("refuses a token that is not valid yet", () => {
    expect(evaluate(liveToken({ nbf: NOW_SECONDS + 60 }))).toEqual({
      outcome: "refused",
      reason: "not-yet-valid",
    });
  });

  it("refuses a refresh token presented as a bearer credential", () => {
    /**
     * A refresh token introspects as ACTIVE. It is only ever meant to be
     * exchanged at the token endpoint, and it outlives every access token, so
     * accepting one here would turn the longest-lived credential in the system
     * into an API key.
     */
    expect(evaluate(liveToken({ token_type: "refresh_token" }))).toEqual({
      outcome: "refused",
      reason: "wrong-token-type",
    });
  });

  it("accepts the RFC 6750 spelling of an access token", () => {
    expect(evaluate(liveToken({ token_type: "Bearer" })).outcome).toBe("accepted");
  });

  it("accepts a token whose type MAS did not report", () => {
    expect(evaluate(liveToken({ token_type: undefined })).outcome).toBe("accepted");
  });

  it("refuses a token another issuer vouched for", () => {
    expect(evaluate(liveToken({ iss: "https://auth.evil.example/" }))).toEqual({
      outcome: "refused",
      reason: "wrong-issuer",
    });
  });

  it("accepts our own issuer whether or not it carries a trailing slash", () => {
    expect(evaluate(liveToken({ iss: "https://auth.allo.you" })).outcome).toBe("accepted");
    expect(evaluate(liveToken({ iss: "https://auth.allo.you/" })).outcome).toBe("accepted");
  });

  it("refuses a token for another audience when an audience is expected", () => {
    const withAudience = config({ ALLO_MAS_EXPECTED_AUDIENCE: "https://api.allo.you" });

    expect(evaluate(liveToken({ aud: "https://api.somewhere.else" }), withAudience)).toEqual({
      outcome: "refused",
      reason: "wrong-audience",
    });
  });

  it("refuses a token with no audience at all when an audience is expected", () => {
    const withAudience = config({ ALLO_MAS_EXPECTED_AUDIENCE: "https://api.allo.you" });

    expect(evaluate(liveToken(), withAudience)).toEqual({
      outcome: "refused",
      reason: "wrong-audience",
    });
  });

  it("accepts an audience list containing the expected one", () => {
    const withAudience = config({ ALLO_MAS_EXPECTED_AUDIENCE: "https://api.allo.you" });
    const response = liveToken({ aud: ["https://matrix.allo.you", "https://api.allo.you"] });

    expect(evaluate(response, withAudience).outcome).toBe("accepted");
  });

  it("refuses a token carrying no Matrix client-API scope", () => {
    /**
     * The audience check for an opaque token. A MAS admin token and a bare
     * `openid` token from another client of the same issuer are both `active`,
     * and neither is a Matrix session.
     */
    expect(evaluate(liveToken({ scope: "openid email" }))).toEqual({
      outcome: "refused",
      reason: "missing-scope",
    });
  });

  it("refuses a token with no scope at all", () => {
    expect(evaluate(liveToken({ scope: undefined }))).toEqual({
      outcome: "refused",
      reason: "missing-scope",
    });
  });

  it("refuses a scope that merely contains an accepted one as a substring", () => {
    /**
     * `urn:matrix:client:api:*:readonly` is not `urn:matrix:client:api:*`.
     * Scopes are space-delimited tokens and are matched whole; a substring
     * match would accept anything an authorization server invents that happens
     * to start with the right prefix.
     */
    expect(evaluate(liveToken({ scope: "urn:matrix:client:api:*:readonly" }))).toEqual({
      outcome: "refused",
      reason: "missing-scope",
    });
  });

  it("accepts either spelling of the MSC2967 client-API scope", () => {
    expect(evaluate(liveToken({ scope: "urn:matrix:client:api:*" })).outcome).toBe("accepted");
    expect(
      evaluate(liveToken({ scope: "urn:matrix:org.matrix.msc2967.client:api:*" })).outcome,
    ).toBe("accepted");
  });

  it("accepts any client of the issuer when no allowlist is configured", () => {
    expect(evaluate(liveToken({ client_id: "somebody-elses-client" })).outcome).toBe("accepted");
  });

  it("refuses a client outside the allowlist when one is configured", () => {
    const pinned = config({ ALLO_MAS_ALLOWED_CLIENT_IDS: "allo-web,allo-native" });

    expect(evaluate(liveToken({ client_id: "somebody-elses-client" }), pinned)).toEqual({
      outcome: "refused",
      reason: "client-not-allowed",
    });
  });

  it("refuses a token with no client at all when an allowlist is configured", () => {
    const pinned = config({ ALLO_MAS_ALLOWED_CLIENT_IDS: "allo-web" });

    expect(evaluate(liveToken({ client_id: undefined }), pinned)).toEqual({
      outcome: "refused",
      reason: "client-not-allowed",
    });
  });

  it("accepts a client inside the allowlist", () => {
    const pinned = config({ ALLO_MAS_ALLOWED_CLIENT_IDS: "allo-web,allo-native" });

    expect(evaluate(liveToken({ client_id: "allo-native" }), pinned).outcome).toBe("accepted");
  });

  it("refuses a response naming no subject", () => {
    expect(evaluate(liveToken({ username: undefined }))).toEqual({
      outcome: "refused",
      reason: "no-subject",
    });
  });

  it("refuses a blank subject", () => {
    expect(evaluate(liveToken({ username: "   " }))).toEqual({
      outcome: "refused",
      reason: "no-subject",
    });
  });

  it("refuses a localpart that is not an Oxy account id", () => {
    expect(evaluate(liveToken({ username: "alice" }))).toEqual({
      outcome: "refused",
      reason: "not-an-oxy-account",
    });
  });

  it("refuses an ObjectId-shaped subject with uppercase hex", () => {
    /**
     * A Matrix localpart is lowercase-only, so `507F1F77BCF86CD799439011` is
     * not a localpart any homeserver would mint — and accepting it would mean
     * one Oxy account has two spellings on this boundary.
     */
    expect(evaluate(liveToken({ username: OXY_USER_ID.toUpperCase() }))).toEqual({
      outcome: "refused",
      reason: "not-an-oxy-account",
    });
  });

  it("refuses a subject that is too short to be an Oxy account id", () => {
    expect(evaluate(liveToken({ username: "507f1f77bcf86cd7994390" }))).toEqual({
      outcome: "refused",
      reason: "not-an-oxy-account",
    });
  });

  it("refuses a subject that is longer than an Oxy account id", () => {
    expect(evaluate(liveToken({ username: `${OXY_USER_ID}00` }))).toEqual({
      outcome: "refused",
      reason: "not-an-oxy-account",
    });
  });

  it("refuses every bridge puppet in the catalogue", () => {
    /**
     * Nobody behind `@whatsapp_447700900000` or `@whatsappbot` ever signed up
     * to Allo, so neither names an account that could be authenticated. Derived
     * from the catalogue rather than listed, so a network added there cannot be
     * forgotten here.
     */
    for (const network of BRIDGE_NETWORK_IDS) {
      expect(evaluate(liveToken({ username: `${network}_447700900000` }))).toEqual({
        outcome: "refused",
        reason: "not-an-oxy-account",
      });
      expect(evaluate(liveToken({ username: `${network}bot` }))).toEqual({
        outcome: "refused",
        reason: "not-an-oxy-account",
      });
    }
  });

  it("refuses an MXID from another homeserver", () => {
    /**
     * MAS reports a bare localpart, so a sigil arriving at all is unusual — and
     * it is judged as a full MXID rather than shrugged at. The server name is
     * unset in this suite, so no MXID can be judged to belong to us, and the
     * safe answer to "I cannot tell" is no.
     */
    expect(evaluate(liveToken({ username: `@${OXY_USER_ID}:elsewhere.example` }))).toEqual({
      outcome: "refused",
      reason: "not-an-oxy-account",
    });
  });

  it("refuses an MXID even for our own account when no server name is configured", () => {
    expect(evaluate(liveToken({ username: `@${OXY_USER_ID}:allo.you` }))).toEqual({
      outcome: "refused",
      reason: "not-an-oxy-account",
    });
  });
});

describe("the introspection cache", () => {
  let clock: number;
  let responses: Introspection[];
  let calls: number;

  function httpFetchReturning(): HttpFetch {
    return async () => {
      const body = responses[Math.min(calls, responses.length - 1)];
      calls += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
  }

  function authenticator(configuration: MatrixAuthConfig = config()) {
    return createMatrixTokenAuthenticator({
      config: configuration,
      httpFetch: httpFetchReturning(),
      now: () => clock,
    });
  }

  beforeEach(() => {
    clock = NOW_SECONDS * 1000;
    calls = 0;
    responses = [liveToken()];
  });

  it("asks MAS once and reuses the answer inside the window", async () => {
    const auth = authenticator();

    await auth.authenticate("token-a");
    await auth.authenticate("token-a");
    await auth.authenticate("token-a");

    expect(calls).toBe(1);
  });

  it("asks again once the window has passed", async () => {
    const auth = authenticator();

    await auth.authenticate("token-a");
    clock += 30_001;
    await auth.authenticate("token-a");

    expect(calls).toBe(2);
  });

  it("stops accepting a revoked token within the cache window", async () => {
    /**
     * The property the whole bound exists for. MAS is told the token is dead
     * one millisecond after it was cached alive, and the authenticator keeps
     * saying yes — for at most 30 seconds, and then no.
     */
    const auth = authenticator();
    responses = [liveToken(), { active: false }];

    expect((await auth.authenticate("token-a")).outcome).toBe("accepted");

    clock += 29_000;
    expect((await auth.authenticate("token-a")).outcome).toBe("accepted");

    clock += 2_000;
    expect((await auth.authenticate("token-a")).outcome).toBe("refused");
  });

  it("honours a configured window shorter than the default", async () => {
    const auth = authenticator(config({ ALLO_MAS_INTROSPECTION_CACHE_SECONDS: "5" }));
    responses = [liveToken(), { active: false }];

    expect((await auth.authenticate("token-a")).outcome).toBe("accepted");
    clock += 5_001;
    expect((await auth.authenticate("token-a")).outcome).toBe("refused");
  });

  it("never caches past the token's own expiry", async () => {
    /**
     * A token with four seconds left is cached for four, not for thirty. `exp`
     * is a ceiling ON TOP of the configured ceiling; without that, the cache
     * would keep serving a token that had run out.
     */
    const auth = authenticator();
    responses = [liveToken({ exp: NOW_SECONDS + 4 }), { active: false }];

    expect((await auth.authenticate("token-a")).outcome).toBe("accepted");
    clock += 4_001;
    await auth.authenticate("token-a");

    expect(calls).toBe(2);
  });

  it("keeps one answer per token", async () => {
    const auth = authenticator();

    await auth.authenticate("token-a");
    await auth.authenticate("token-b");

    expect(calls).toBe(2);
  });

  it("remembers a refusal only briefly", async () => {
    const auth = authenticator();
    responses = [{ active: false }];

    await auth.authenticate("token-a");
    clock += 4_000;
    await auth.authenticate("token-a");
    expect(calls).toBe(1);

    clock += 2_000;
    await auth.authenticate("token-a");
    expect(calls).toBe(2);
  });

  it("collapses a burst of concurrent requests into one round trip", async () => {
    const auth = authenticator();

    const results = await Promise.all([
      auth.authenticate("token-a"),
      auth.authenticate("token-a"),
      auth.authenticate("token-a"),
      auth.authenticate("token-a"),
    ]);

    expect(calls).toBe(1);
    expect(results.every((result) => result.outcome === "accepted")).toBe(true);
  });

  it("never caches an upstream failure", async () => {
    /**
     * MAS being down is not evidence about a token. If a failure were cached,
     * a single blip would refuse every request for the length of the window
     * even after MAS came back.
     */
    let attempt = 0;
    const auth = createMatrixTokenAuthenticator({
      config: config(),
      now: () => clock,
      httpFetch: async () => {
        attempt += 1;
        if (attempt === 1) throw new TypeError("fetch failed");
        return new Response(JSON.stringify(liveToken()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await expect(auth.authenticate("token-a")).rejects.toBeInstanceOf(MasUnreachableError);
    expect((await auth.authenticate("token-a")).outcome).toBe("accepted");
  });

  it("hands every concurrent caller the same upstream failure", async () => {
    let attempts = 0;
    const auth = createMatrixTokenAuthenticator({
      config: config(),
      now: () => clock,
      httpFetch: async () => {
        attempts += 1;
        throw new TypeError("fetch failed");
      },
    });

    const outcomes = await Promise.allSettled([
      auth.authenticate("token-a"),
      auth.authenticate("token-a"),
    ]);

    expect(attempts).toBe(1);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
  });

  it("evicts oldest-first rather than growing without limit", async () => {
    /**
     * A cache keyed by an attacker-supplied string with no ceiling is a memory
     * exhaustion primitive: twelve thousand invented tokens would be twelve
     * thousand live entries.
     *
     * A bound is only testable through what it EVICTS, so that is what is
     * asserted. After the spray, the oldest sprayed token has to cost a fresh
     * round trip and the newest must not — which is false both if the ceiling
     * is removed (nothing evicted) and if eviction ran the wrong way round.
     */
    const auth = authenticator();
    responses = [{ active: false }];

    for (let index = 0; index < 12_000; index += 1) {
      await auth.authenticate(`sprayed-token-${index}`);
    }
    expect(calls).toBe(12_000);

    calls = 0;
    await auth.authenticate("sprayed-token-11999");
    expect(calls).toBe(0);

    await auth.authenticate("sprayed-token-0");
    expect(calls).toBe(1);
  });

  it("keeps answering correctly after a spray", async () => {
    const auth = authenticator();
    responses = [{ active: false }];
    for (let index = 0; index < 12_000; index += 1) {
      await auth.authenticate(`sprayed-token-${index}`);
    }

    responses = [liveToken()];
    calls = 0;

    expect((await auth.authenticate("a-real-token")).outcome).toBe("accepted");
    expect((await auth.authenticate("a-real-token")).outcome).toBe("accepted");
    expect(calls).toBe(1);
  });

  it("does not confuse two tokens that share a prefix", async () => {
    const auth = authenticator();
    responses = [liveToken(), liveToken({ username: "aaaaaaaaaaaaaaaaaaaaaaaa" })];

    const first = await auth.authenticate("token-a");
    const second = await auth.authenticate("token-aa");

    expect(first).toEqual({ outcome: "accepted", oxyUserId: OXY_USER_ID, deviceId: "ABCDEFGH" });
    expect(second).toEqual({
      outcome: "accepted",
      oxyUserId: "aaaaaaaaaaaaaaaaaaaaaaaa",
      deviceId: "ABCDEFGH",
    });
  });
});
