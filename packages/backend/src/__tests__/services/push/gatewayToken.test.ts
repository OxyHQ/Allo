import { describe, expect, it } from "vitest";

import { PUSH_GATEWAY_PATH } from "../../../config/push";
import {
  GATEWAY_TOKEN_PARAMETER,
  gatewayToken,
  mintGatewayUrl,
  verifyGatewayToken,
} from "../../../services/push/gatewayToken";

/**
 * The capability that stops the push gateway being a spam relay.
 *
 * These are the properties the design rests on, tested as properties rather than
 * as "the function returns a string": what the token is bound to, what it is not
 * bound to, and what a rotation does to the pushers already registered.
 */

const GATEWAY_URL = `https://api.allo.you${PUSH_GATEWAY_PATH}`;
const CURRENT = "a-push-gateway-secret-long-enough-32ch";
const PREVIOUS = "the-previous-gateway-secret-32-chars-x";
const IDENTITY = { appId: "so.oxy.allo.android", pushkey: "device-token-aaa" } as const;

describe("a minted gateway URL", () => {
  it("is the configured URL with the token in the query", () => {
    const url = new URL(mintGatewayUrl(GATEWAY_URL, CURRENT, IDENTITY));

    expect(url.origin + url.pathname).toBe(GATEWAY_URL);
    expect(url.searchParams.get(GATEWAY_TOKEN_PARAMETER)).toBe(
      gatewayToken(CURRENT, IDENTITY),
    );
  });

  it("verifies against the pusher it was minted for", () => {
    const token = new URL(mintGatewayUrl(GATEWAY_URL, CURRENT, IDENTITY)).searchParams.get(
      GATEWAY_TOKEN_PARAMETER,
    );

    expect(token).not.toBeNull();
    expect(verifyGatewayToken(token ?? "", IDENTITY, [CURRENT])).toBe(true);
  });
});

describe("what the token is bound to", () => {
  it("does not authenticate another device", () => {
    const token = gatewayToken(CURRENT, IDENTITY);

    expect(
      verifyGatewayToken(token, { ...IDENTITY, pushkey: "device-token-bbb" }, [CURRENT]),
    ).toBe(false);
  });

  it("does not authenticate the same device under another app id", () => {
    const token = gatewayToken(CURRENT, IDENTITY);

    expect(verifyGatewayToken(token, { ...IDENTITY, appId: "so.oxy.allo.ios" }, [CURRENT])).toBe(
      false,
    );
  });

  it("does not authenticate under a secret this deployment does not hold", () => {
    const token = gatewayToken("a-secret-from-another-deployment-32ch", IDENTITY);

    expect(verifyGatewayToken(token, IDENTITY, [CURRENT])).toBe(false);
  });

  it("cannot be reassembled by moving the boundary between app id and pushkey", () => {
    /**
     * The reason the signed message is length-prefixed rather than joined by a
     * delimiter. If it were concatenated, these two pairs would sign identical
     * bytes and a token minted for the attacker's own app id would authenticate
     * somebody else's device.
     */
    const first = gatewayToken(CURRENT, { appId: "so.oxy.a", pushkey: "bbb" });
    const second = gatewayToken(CURRENT, { appId: "so.oxy.ab", pushkey: "bb" });

    expect(first).not.toBe(second);
    expect(verifyGatewayToken(first, { appId: "so.oxy.ab", pushkey: "bb" }, [CURRENT])).toBe(
      false,
    );
  });
});

describe("rotating the secret", () => {
  it("keeps the pushers minted under the previous one working", () => {
    const old = gatewayToken(PREVIOUS, IDENTITY);

    expect(verifyGatewayToken(old, IDENTITY, [CURRENT, PREVIOUS])).toBe(true);
  });

  it("mints new URLs under the first secret only", () => {
    const url = new URL(mintGatewayUrl(GATEWAY_URL, CURRENT, IDENTITY));

    expect(url.searchParams.get(GATEWAY_TOKEN_PARAMETER)).not.toBe(
      gatewayToken(PREVIOUS, IDENTITY),
    );
  });

  it("stops accepting a secret once it is dropped from the list", () => {
    const old = gatewayToken(PREVIOUS, IDENTITY);

    expect(verifyGatewayToken(old, IDENTITY, [CURRENT])).toBe(false);
  });
});

describe("a malformed token", () => {
  it.each(["", "not-a-token", "a".repeat(1000)])("is refused rather than throwing (%s)", (
    supplied,
  ) => {
    expect(verifyGatewayToken(supplied, IDENTITY, [CURRENT])).toBe(false);
  });

  it("is refused when there are no secrets at all", () => {
    expect(verifyGatewayToken(gatewayToken(CURRENT, IDENTITY), IDENTITY, [])).toBe(false);
  });
});
