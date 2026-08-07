import { describe, expect, it } from "vitest";

import { loadMatrixAuthConfig } from "../../config/matrixAuth";

/**
 * `config/matrixAuth.ts` — the boot-time checks on the MAS half of the one
 * session.
 *
 * These are not preference checks. Each one below is a way a deployment could
 * come up ACCEPTING TOKENS IT SHOULD NOT, so each is written as "this
 * environment does not produce a running process" rather than as "this value is
 * normalised to something safe".
 */

const ISSUER = "https://auth.allo.you/";
const INTROSPECTION_URL = "https://auth.allo.you/oauth2/introspect";
const CLIENT_ID = "allo-backend";
const CLIENT_SECRET = "0123456789abcdef0123456789abcdef";

function completeEnvironment(
  overrides: Record<string, string | undefined> = {},
): NodeJS.ProcessEnv {
  return {
    ALLO_MAS_ISSUER: ISSUER,
    ALLO_MAS_INTROSPECTION_URL: INTROSPECTION_URL,
    ALLO_MAS_INTROSPECTION_CLIENT_ID: CLIENT_ID,
    ALLO_MAS_INTROSPECTION_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  };
}

describe("matrix auth configuration", () => {
  it("is disabled, and boots, when no issuer is configured", () => {
    const config = loadMatrixAuthConfig({});

    expect(config.enabled).toBe(false);
  });

  it("ignores every other MAS variable when the issuer is absent", () => {
    /**
     * A deployment that once accepted MAS tokens and no longer does turns the
     * issuer off and leaves the rest behind. Refusing to boot over a variable
     * that now decides nothing would make that a two-step change with an
     * outage in the middle.
     */
    const config = loadMatrixAuthConfig({
      ALLO_MAS_INTROSPECTION_URL: INTROSPECTION_URL,
      ALLO_MAS_INTROSPECTION_CLIENT_ID: CLIENT_ID,
      ALLO_MAS_INTROSPECTION_CLIENT_SECRET: CLIENT_SECRET,
    });

    expect(config.enabled).toBe(false);
  });

  it("enables the MAS path when every required variable is present", () => {
    const config = loadMatrixAuthConfig(completeEnvironment());

    expect(config.enabled).toBe(true);
    expect(config.issuer).toBe(ISSUER);
    expect(config.introspectionUrl).toBe(INTROSPECTION_URL);
    expect(config.clientId).toBe(CLIENT_ID);
  });

  it("refuses an introspection endpoint on another origin", () => {
    /**
     * The single most important check in the file. MAS sends no `iss`, so
     * "which server answered" IS the issuer verification; an endpoint on
     * another host is a stranger being asked to authenticate our users.
     */
    expect(() =>
      loadMatrixAuthConfig(
        completeEnvironment({ ALLO_MAS_INTROSPECTION_URL: "https://evil.example/oauth2/introspect" }),
      ),
    ).toThrow(/same-origin/);
  });

  it("refuses an introspection endpoint that differs only by port", () => {
    expect(() =>
      loadMatrixAuthConfig(
        completeEnvironment({
          ALLO_MAS_INTROSPECTION_URL: "https://auth.allo.you:8443/oauth2/introspect",
        }),
      ),
    ).toThrow(/same-origin/);
  });

  it("refuses a plaintext issuer", () => {
    expect(() =>
      loadMatrixAuthConfig(
        completeEnvironment({
          ALLO_MAS_ISSUER: "http://auth.allo.you/",
          ALLO_MAS_INTROSPECTION_URL: "http://auth.allo.you/oauth2/introspect",
        }),
      ),
    ).toThrow(/https/);
  });

  it("refuses an issuer carrying credentials", () => {
    expect(() =>
      loadMatrixAuthConfig(
        completeEnvironment({ ALLO_MAS_ISSUER: "https://user:pass@auth.allo.you/" }),
      ),
    ).toThrow();
  });

  it("refuses an issuer without an introspection endpoint", () => {
    expect(() =>
      loadMatrixAuthConfig(
        completeEnvironment({ ALLO_MAS_INTROSPECTION_URL: undefined }),
      ),
    ).toThrow(/ALLO_MAS_INTROSPECTION_URL/);
  });

  it("refuses an issuer without introspection credentials", () => {
    expect(() =>
      loadMatrixAuthConfig(
        completeEnvironment({
          ALLO_MAS_INTROSPECTION_CLIENT_ID: undefined,
          ALLO_MAS_INTROSPECTION_CLIENT_SECRET: undefined,
        }),
      ),
    ).toThrow(/ALLO_MAS_INTROSPECTION_CLIENT_ID/);
  });

  it("refuses a client secret shorter than 32 characters", () => {
    expect(() =>
      loadMatrixAuthConfig(
        completeEnvironment({ ALLO_MAS_INTROSPECTION_CLIENT_SECRET: "short-secret" }),
      ),
    ).toThrow();
  });

  it("treats a blank variable as absent rather than as an empty value", () => {
    /**
     * An unset variable and a variable set to the empty string reach a process
     * the same way through most deployment tooling, and one of the two reading
     * as "a client id of length zero" would be a 400 from MAS on every request.
     */
    const config = loadMatrixAuthConfig({ ALLO_MAS_ISSUER: "   " });

    expect(config.enabled).toBe(false);
  });

  it("defaults to both spellings of the MSC2967 client-API scope", () => {
    const config = loadMatrixAuthConfig(completeEnvironment());

    expect(config.acceptedScopes).toEqual([
      "urn:matrix:org.matrix.msc2967.client:api:*",
      "urn:matrix:client:api:*",
    ]);
  });

  it("parses comma-separated lists and drops blank entries", () => {
    const config = loadMatrixAuthConfig(
      completeEnvironment({
        ALLO_MAS_ALLOWED_CLIENT_IDS: " one , , two ",
        ALLO_MAS_ACCEPTED_SCOPES: "urn:matrix:client:api:*",
      }),
    );

    expect(config.allowedClientIds).toEqual(["one", "two"]);
    expect(config.acceptedScopes).toEqual(["urn:matrix:client:api:*"]);
  });

  it("defaults the cache window to 30 seconds", () => {
    expect(loadMatrixAuthConfig(completeEnvironment()).cacheSeconds).toBe(30);
  });

  it("refuses a cache window longer than five minutes", () => {
    /**
     * The cache window is the bound on how long a revoked token keeps working.
     * A deployment must not be able to widen it into "until the token would
     * have expired anyway", which is what caching for `exp` would mean.
     */
    expect(() =>
      loadMatrixAuthConfig(
        completeEnvironment({ ALLO_MAS_INTROSPECTION_CACHE_SECONDS: "3600" }),
      ),
    ).toThrow();
  });

  it("refuses a cache window of zero", () => {
    expect(() =>
      loadMatrixAuthConfig(completeEnvironment({ ALLO_MAS_INTROSPECTION_CACHE_SECONDS: "0" })),
    ).toThrow();
  });

  it("freezes the result so no caller can widen it at runtime", () => {
    const config = loadMatrixAuthConfig(completeEnvironment());

    expect(Object.isFrozen(config)).toBe(true);
  });
});
