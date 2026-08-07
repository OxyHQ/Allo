import { describe, expect, it, vi } from "vitest";

import { configureOxyServiceAuth, loadOxyServiceCredential } from "../../config/oxyService";

/**
 * Allo's own credential for calling Oxy as itself.
 *
 * Optional — every Oxy route the directory uses is public — so the tests are
 * about the two ways a deployment can be wrong about it: half-configured, which
 * must not boot, and configured with something that is not a credential.
 */

const API_KEY = "oxy_dk_0123456789abcdef0123456789abcdef0123456789abcdef";
const API_SECRET = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928";

describe("the Oxy service credential", () => {
  it("is absent when neither variable is set", () => {
    expect(loadOxyServiceCredential({})).toBeUndefined();
  });

  it("is read when both are set", () => {
    expect(
      loadOxyServiceCredential({
        ALLO_OXY_SERVICE_API_KEY: API_KEY,
        ALLO_OXY_SERVICE_API_SECRET: API_SECRET,
      }),
    ).toEqual({ apiKey: API_KEY, apiSecret: API_SECRET });
  });

  it("refuses a key without its secret", () => {
    /**
     * Half a credential is a service token that can never be minted, and the
     * way that shows up in production is every bulk profile lookup quietly
     * returning nothing — `getUsersByIds` logs a failed chunk and carries on.
     */
    expect(() => loadOxyServiceCredential({ ALLO_OXY_SERVICE_API_KEY: API_KEY })).toThrow(
      /ALLO_OXY_SERVICE_API_SECRET/,
    );
  });

  it("refuses a secret without its key", () => {
    expect(() => loadOxyServiceCredential({ ALLO_OXY_SERVICE_API_SECRET: API_SECRET })).toThrow(
      /ALLO_OXY_SERVICE_API_KEY/,
    );
  });

  it("refuses something that is not an Oxy credential public key", () => {
    expect(() =>
      loadOxyServiceCredential({
        ALLO_OXY_SERVICE_API_KEY: "not-an-oxy-key",
        ALLO_OXY_SERVICE_API_SECRET: API_SECRET,
      }),
    ).toThrow(/oxy_dk_/);
  });

  it("refuses a secret too short to be one", () => {
    expect(() =>
      loadOxyServiceCredential({
        ALLO_OXY_SERVICE_API_KEY: API_KEY,
        ALLO_OXY_SERVICE_API_SECRET: "short",
      }),
    ).toThrow();
  });

  it("treats blank variables as absent", () => {
    expect(
      loadOxyServiceCredential({
        ALLO_OXY_SERVICE_API_KEY: "  ",
        ALLO_OXY_SERVICE_API_SECRET: "",
      }),
    ).toBeUndefined();
  });
});

describe("handing the credential to the SDK", () => {
  it("configures the client and says so", () => {
    const client = { configureServiceAuth: vi.fn() };

    const configured = configureOxyServiceAuth(client, {
      ALLO_OXY_SERVICE_API_KEY: API_KEY,
      ALLO_OXY_SERVICE_API_SECRET: API_SECRET,
    });

    expect(configured).toBe(true);
    expect(client.configureServiceAuth).toHaveBeenCalledWith(API_KEY, API_SECRET);
  });

  it("leaves the client alone when there is no credential", () => {
    const client = { configureServiceAuth: vi.fn() };

    expect(configureOxyServiceAuth(client, {})).toBe(false);
    expect(client.configureServiceAuth).not.toHaveBeenCalled();
  });
});
