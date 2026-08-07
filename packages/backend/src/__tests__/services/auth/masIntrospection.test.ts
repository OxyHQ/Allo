import { describe, expect, it, vi } from "vitest";

import { loadMatrixAuthConfig, type MatrixAuthConfig } from "../../../config/matrixAuth";
import {
  introspectAccessToken,
  MasCredentialError,
  MasProtocolError,
  MasUnreachableError,
  type HttpFetch,
} from "../../../services/auth/masIntrospection";

/**
 * The one HTTP call the Matrix authentication path makes.
 *
 * What is tested here is the SHAPE of the request — because MAS answers a
 * malformed one with a 400 that reads exactly like a wrong secret — and the way
 * each kind of failure is separated, because collapsing "MAS is down" into
 * "your token is invalid" signs every user out of every device the moment MAS
 * restarts.
 */

const ISSUER = "https://auth.allo.you/";
const INTROSPECTION_URL = "https://auth.allo.you/oauth2/introspect";
const CLIENT_ID = "allo-backend";
const CLIENT_SECRET = "0123456789abcdef0123456789abcdef";
const TOKEN = "mct_aVeryOpaqueMatrixAccessToken";

function config(overrides: Record<string, string> = {}): MatrixAuthConfig {
  return loadMatrixAuthConfig({
    ALLO_MAS_ISSUER: ISSUER,
    ALLO_MAS_INTROSPECTION_URL: INTROSPECTION_URL,
    ALLO_MAS_INTROSPECTION_CLIENT_ID: CLIENT_ID,
    ALLO_MAS_INTROSPECTION_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The rejection value, as a value.
 *
 * `rejects.toThrow(matcher)` was used here first and is a trap: `toThrow` takes
 * a string, a RegExp, an Error or a class, and an asymmetric matcher handed to
 * it asserts nothing at all — the test passes whatever the message says. These
 * assertions are about what a message must NOT contain, so they are made
 * against the value directly, where a wrong answer is a failure.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, and it resolved");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function respondingWith(response: Response): { fetch: HttpFetch; calls: RequestInit[] } {
  const calls: RequestInit[] = [];
  const fetch: HttpFetch = vi.fn(async (_url, init) => {
    calls.push(init);
    return response;
  });
  return { fetch, calls };
}

describe("MAS token introspection", () => {
  it("POSTs form-encoded to the configured endpoint and nowhere else", async () => {
    const urls: string[] = [];
    const httpFetch: HttpFetch = vi.fn(async (url, _init) => {
      urls.push(url);
      return jsonResponse({ active: false });
    });

    await introspectAccessToken(TOKEN, config(), httpFetch);

    expect(urls).toEqual([INTROSPECTION_URL]);
  });

  it("never puts the token in the URL", async () => {
    /**
     * A token in a query string is a token in an access log, in a proxy's
     * metrics and in a browser's history. RFC 7662 puts it in the body; this
     * test is what keeps it there.
     */
    const urls: string[] = [];
    const httpFetch: HttpFetch = vi.fn(async (url, _init) => {
      urls.push(url);
      return jsonResponse({ active: false });
    });

    await introspectAccessToken(TOKEN, config(), httpFetch);

    expect(urls[0]).not.toContain(TOKEN);
  });

  it("sends the token and the access-token hint in a form body", async () => {
    const { fetch, calls } = respondingWith(jsonResponse({ active: false }));

    await introspectAccessToken(TOKEN, config(), fetch);

    const [init] = calls;
    expect(init.method).toBe("POST");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("token")).toBe(TOKEN);
    expect(body.get("token_type_hint")).toBe("access_token");
  });

  it("authenticates with client_secret_basic", async () => {
    const { fetch, calls } = respondingWith(jsonResponse({ active: false }));

    await introspectAccessToken(TOKEN, config(), fetch);

    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const [scheme, credentials] = headers.authorization.split(" ");
    expect(scheme).toBe("Basic");
    expect(Buffer.from(credentials, "base64").toString("utf8")).toBe(
      `${CLIENT_ID}:${CLIENT_SECRET}`,
    );
  });

  it("form-urlencodes a client secret before base64, as RFC 6749 requires", async () => {
    /**
     * A secret containing a colon, joined raw, produces credentials MAS splits
     * in the wrong place — and the resulting 401 reads as "wrong secret",
     * which sends whoever is debugging it to rotate a perfectly good one.
     */
    const awkwardSecret = "aa:bb cc+dd%ee0123456789abcdef0123456789";
    const { fetch, calls } = respondingWith(jsonResponse({ active: false }));

    await introspectAccessToken(
      TOKEN,
      config({ ALLO_MAS_INTROSPECTION_CLIENT_SECRET: awkwardSecret }),
      fetch,
    );

    const headers = calls[0]?.headers as Record<string, string>;
    const decoded = Buffer.from(headers.authorization.split(" ")[1], "base64").toString("utf8");
    const [encodedId, encodedSecret] = decoded.split(":");
    expect(encodedId).toBe(CLIENT_ID);
    expect(decodeURIComponent(encodedSecret.replace(/\+/g, " "))).toBe(awkwardSecret);
  });

  it("returns the parsed response for a live token", async () => {
    const { fetch } = respondingWith(
      jsonResponse({
        active: true,
        scope: "urn:matrix:client:api:*",
        username: "507f1f77bcf86cd799439011",
        device_id: "ABCDEFGH",
        exp: 4_000_000_000,
      }),
    );

    const response = await introspectAccessToken(TOKEN, config(), fetch);

    expect(response.active).toBe(true);
    expect(response.username).toBe("507f1f77bcf86cd799439011");
    expect(response.device_id).toBe("ABCDEFGH");
  });

  it("returns the bare inactive answer RFC 7662 specifies", async () => {
    const { fetch } = respondingWith(jsonResponse({ active: false }));

    expect(await introspectAccessToken(TOKEN, config(), fetch)).toEqual({ active: false });
  });

  it("drops a field MAS adds that this module does not know about", async () => {
    /**
     * `passthrough` is deliberately not used: a field nobody decided to trust
     * must not be able to reach a decision just because MAS started sending it.
     */
    const { fetch } = respondingWith(
      jsonResponse({ active: true, some_future_field: "whatever", username: "x" }),
    );

    const response = await introspectAccessToken(TOKEN, config(), fetch);

    expect(response).not.toHaveProperty("some_future_field");
  });

  it("raises a credential error, not a token error, when MAS answers 401", async () => {
    const { fetch } = respondingWith(new Response("", { status: 401 }));

    await expect(introspectAccessToken(TOKEN, config(), fetch)).rejects.toBeInstanceOf(
      MasCredentialError,
    );
  });

  it("raises a credential error when MAS answers 403", async () => {
    const { fetch } = respondingWith(new Response("", { status: 403 }));

    await expect(introspectAccessToken(TOKEN, config(), fetch)).rejects.toBeInstanceOf(
      MasCredentialError,
    );
  });

  it("names the two variables to check in the credential error", async () => {
    const { fetch } = respondingWith(new Response("", { status: 401 }));

    await expect(introspectAccessToken(TOKEN, config(), fetch)).rejects.toThrow(
      /ALLO_MAS_INTROSPECTION_CLIENT_ID/,
    );
  });

  it("never puts the client secret in the credential error", async () => {
    const { fetch } = respondingWith(new Response("", { status: 401 }));

    const error = await rejectionOf(introspectAccessToken(TOKEN, config(), fetch));

    expect(error).toBeInstanceOf(MasCredentialError);
    expect(messageOf(error)).not.toContain(CLIENT_SECRET);
  });

  it("raises unreachable when MAS answers 5xx", async () => {
    const { fetch } = respondingWith(new Response("", { status: 502 }));

    await expect(introspectAccessToken(TOKEN, config(), fetch)).rejects.toBeInstanceOf(
      MasUnreachableError,
    );
  });

  it("raises unreachable when the request itself fails", async () => {
    const httpFetch: HttpFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    await expect(introspectAccessToken(TOKEN, config(), httpFetch)).rejects.toBeInstanceOf(
      MasUnreachableError,
    );
  });

  it("never puts the token in the unreachable error", async () => {
    /**
     * A fetch failure's own message can quote the request, and the request body
     * is the user's access token. Only the error's CLASS NAME is used.
     */
    const httpFetch: HttpFetch = vi.fn(async () => {
      throw new TypeError(`fetch failed for body token=${TOKEN}`);
    });

    const error = await rejectionOf(introspectAccessToken(TOKEN, config(), httpFetch));

    expect(error).toBeInstanceOf(MasUnreachableError);
    expect(messageOf(error)).not.toContain(TOKEN);
  });

  it("abandons a request that outlives the timeout", async () => {
    const httpFetch: HttpFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });

    await expect(
      introspectAccessToken(
        TOKEN,
        config({ ALLO_MAS_INTROSPECTION_TIMEOUT_MS: "500" }),
        httpFetch,
      ),
    ).rejects.toBeInstanceOf(MasUnreachableError);
  });

  it("raises a protocol error when the body is not JSON", async () => {
    const { fetch } = respondingWith(new Response("<html>maintenance</html>", { status: 200 }));

    await expect(introspectAccessToken(TOKEN, config(), fetch)).rejects.toBeInstanceOf(
      MasProtocolError,
    );
  });

  it("raises a protocol error when `active` is missing", async () => {
    const { fetch } = respondingWith(jsonResponse({ username: "507f1f77bcf86cd799439011" }));

    await expect(introspectAccessToken(TOKEN, config(), fetch)).rejects.toBeInstanceOf(
      MasProtocolError,
    );
  });

  it("raises a protocol error when `active` is a string", async () => {
    /**
     * `"false"` is truthy. A schema that coerced it would authenticate every
     * refused token an authorization server ever reported.
     */
    const { fetch } = respondingWith(jsonResponse({ active: "false" }));

    await expect(introspectAccessToken(TOKEN, config(), fetch)).rejects.toBeInstanceOf(
      MasProtocolError,
    );
  });

  it("never quotes the response body in a protocol error", async () => {
    const { fetch } = respondingWith(
      jsonResponse({ active: "yes", username: "507f1f77bcf86cd799439011" }),
    );

    const error = await rejectionOf(introspectAccessToken(TOKEN, config(), fetch));

    expect(error).toBeInstanceOf(MasProtocolError);
    expect(messageOf(error)).not.toContain("507f1f77bcf86cd799439011");
  });
});
