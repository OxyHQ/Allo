import { createPublicKey, generateKeyPairSync, verify } from "crypto";
import { describe, expect, it } from "vitest";

import type { ApnsCredentials } from "../../../config/push";
import { createApnsTokenProvider, TOKEN_LIFETIME_MS } from "../../../services/push/apnsAuth";

/**
 * The provider token APNs authenticates with.
 *
 * The signature is verified here with Node's own verifier rather than compared
 * against a fixture, because the failure this catches is a real one: an ECDSA
 * signature in Node's default DER encoding is a perfectly valid signature that
 * no JWT verifier on earth accepts, and Apple reports it as
 * `InvalidProviderToken` — which reads as "the key is wrong" and sends everybody
 * looking in the wrong place.
 */

function credentials(): { credentials: ApnsCredentials; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    credentials: {
      keyId: "ABCD1234EF",
      teamId: "TEAM123456",
      privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      topic: "so.oxy.allo",
      host: "https://api.push.apple.com",
    },
  };
}

function decodeSegment(segment: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("a JWT segment did not decode to an object");
  }
  return decoded as Record<string, unknown>;
}

describe("the minted token", () => {
  it("names the key in its header and the team as its issuer", () => {
    const { credentials: apns } = credentials();

    const [header, claims] = createApnsTokenProvider(apns).token().split(".");

    expect(decodeSegment(header ?? "")).toEqual({ alg: "ES256", kid: "ABCD1234EF" });
    expect(decodeSegment(claims ?? "")).toEqual({
      iss: "TEAM123456",
      iat: expect.any(Number),
    });
  });

  it("is signed so that an ES256 verifier accepts it", () => {
    const { credentials: apns, publicKeyPem } = credentials();

    const token = createApnsTokenProvider(apns).token();
    const [header, claims, signature] = token.split(".");

    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`, "utf8"),
        { key: createPublicKey(publicKeyPem), dsaEncoding: "ieee-p1363" },
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("does not verify against a different key", () => {
    const { credentials: apns } = credentials();
    const { publicKeyPem: otherKey } = credentials();

    const [header, claims, signature] = createApnsTokenProvider(apns).token().split(".");

    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`, "utf8"),
        { key: createPublicKey(otherKey), dsaEncoding: "ieee-p1363" },
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(false);
  });
});

describe("how often a token is minted", () => {
  it("reuses one within its lifetime, because Apple refuses a provider that mints too often", () => {
    const { credentials: apns } = credentials();
    let clock = 1_700_000_000_000;
    const provider = createApnsTokenProvider(apns, () => clock);

    const first = provider.token();
    clock += TOKEN_LIFETIME_MS - 1;

    expect(provider.token()).toBe(first);
  });

  it("mints a new one once the last has aged out, before Apple would expire it", () => {
    const { credentials: apns } = credentials();
    let clock = 1_700_000_000_000;
    const provider = createApnsTokenProvider(apns, () => clock);

    const first = provider.token();
    clock += TOKEN_LIFETIME_MS;

    expect(provider.token()).not.toBe(first);
  });

  it("stays inside both of Apple's limits: past the twenty-minute floor, short of the hour", () => {
    expect(TOKEN_LIFETIME_MS).toBeGreaterThan(20 * 60 * 1000);
    expect(TOKEN_LIFETIME_MS).toBeLessThan(60 * 60 * 1000);
  });
});
