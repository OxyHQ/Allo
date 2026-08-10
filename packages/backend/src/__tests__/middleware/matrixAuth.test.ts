import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { oxyClient } from "@oxyhq/core";
import { createOxyAuthMiddleware, getOxyUserId } from "@oxyhq/core/server";

import { loadMatrixAuthConfig, type MatrixAuthConfig } from "../../config/matrixAuth";
import {
  createMatrixAuthMiddleware,
  MATRIX_AUTH_SCHEME,
  readPresentedCredential,
} from "../../middleware/matrixAuth";
import {
  MasCredentialError,
  MasProtocolError,
  MasUnreachableError,
} from "../../services/auth/masIntrospection";
import type {
  MatrixTokenAuthenticator,
  MatrixTokenResult,
} from "../../services/auth/matrixTokenAuthenticator";

/**
 * The authentication boundary, assembled the way `server.ts` assembles it.
 *
 * The REAL `createOxyAuthMiddleware` is mounted behind the Matrix one here,
 * rather than a stand-in, because the most important property under test is a
 * property of the two together: an Oxy token and a MAS token cannot be confused
 * for one another. A fake Oxy middleware could be written to agree with any
 * claim about that, which is exactly why it is not used.
 *
 * No test below reaches the network. `oxy.auth()` extracts a token only from a
 * header beginning with the exact string `"Bearer "`, and then decodes it as a
 * JWT before it would validate a session — every Oxy-path case here stops at
 * one of those two steps.
 */

const ISSUER = "https://auth.allo.you/";
const OXY_USER_ID = "507f1f77bcf86cd799439011";
const MATRIX_TOKEN = "mct_aVeryOpaqueMatrixAccessToken";

/**
 * A well-formed Oxy access token in the shape `oxy.auth()` looks for — a JWT —
 * carrying no `sessionId`.
 *
 * On the core Allo now rides (>= 20.1.0) this is REFUSED: a session-less user
 * token is no longer trusted on its claims. It once was — that was the bypass
 * this file's last test now locks closed. It is used here only to drive the Oxy
 * path to a verdict; every assertion that uses it is about ROUTING — that the
 * Matrix middleware hands a `Bearer` request to Oxy untouched — rather than
 * about the verdict itself.
 */
const OXY_TOKEN = [
  Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ userId: OXY_USER_ID, exp: 4_000_000_000 })).toString("base64url"),
  "not-a-real-signature",
].join(".");

function enabledConfig(overrides: Record<string, string> = {}): MatrixAuthConfig {
  return loadMatrixAuthConfig({
    ALLO_MAS_ISSUER: ISSUER,
    ALLO_MAS_INTROSPECTION_URL: "https://auth.allo.you/oauth2/introspect",
    ALLO_MAS_INTROSPECTION_CLIENT_ID: "allo-backend",
    ALLO_MAS_INTROSPECTION_CLIENT_SECRET: "0123456789abcdef0123456789abcdef",
    ...overrides,
  });
}

const DISABLED_CONFIG = loadMatrixAuthConfig({});

let seenTokens: string[];
let routeHits: number;

function authenticatorReturning(result: MatrixTokenResult): MatrixTokenAuthenticator {
  return {
    authenticate: vi.fn(async (token: string) => {
      seenTokens.push(token);
      return result;
    }),
  };
}

function authenticatorThrowing(error: unknown): MatrixTokenAuthenticator {
  return {
    authenticate: vi.fn(async (token: string) => {
      seenTokens.push(token);
      throw error;
    }),
  };
}

/**
 * `/api` exactly as `server.ts` mounts it: Matrix authentication, then Oxy
 * authentication, then the routes.
 */
function api(options: {
  config?: MatrixAuthConfig;
  authenticator?: MatrixTokenAuthenticator;
}): express.Express {
  const app = express();
  const router = express.Router();
  router.get("/whoami", (req, res) => {
    routeHits += 1;
    res.json({ userId: getOxyUserId(req) });
  });

  app.use(
    "/api",
    createMatrixAuthMiddleware({
      config: options.config ?? enabledConfig(),
      ...(options.authenticator === undefined ? {} : { authenticator: options.authenticator }),
    }),
    createOxyAuthMiddleware(oxyClient),
    router,
  );
  return app;
}

const ACCEPTED: MatrixTokenResult = {
  outcome: "accepted",
  oxyUserId: OXY_USER_ID,
  deviceId: "ABCDEFGH",
};

beforeEach(() => {
  seenTokens = [];
  routeHits = 0;
});

describe("how a request declares which token it carries", () => {
  it("reads a MatrixBearer credential", () => {
    expect(readPresentedCredential(`${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`)).toEqual({
      kind: "matrix",
      token: MATRIX_TOKEN,
    });
  });

  it("accepts the scheme in any case, because RFC 7235 says schemes are", () => {
    expect(readPresentedCredential(`matrixbearer ${MATRIX_TOKEN}`)).toEqual({
      kind: "matrix",
      token: MATRIX_TOKEN,
    });
    expect(readPresentedCredential(`MATRIXBEARER ${MATRIX_TOKEN}`)).toEqual({
      kind: "matrix",
      token: MATRIX_TOKEN,
    });
  });

  it("leaves a Bearer credential alone", () => {
    expect(readPresentedCredential(`Bearer ${OXY_TOKEN}`)).toEqual({ kind: "other-scheme" });
  });

  it("leaves an absent header alone", () => {
    expect(readPresentedCredential(undefined)).toEqual({ kind: "other-scheme" });
  });

  it("does not mistake a scheme that merely starts the same way", () => {
    /**
     * `MatrixBearerish` is not `MatrixBearer`. A `startsWith` check on the
     * scheme without the separator would claim it, and would then hand whatever
     * followed to MAS as a token.
     */
    expect(readPresentedCredential(`MatrixBearerish ${MATRIX_TOKEN}`)).toEqual({
      kind: "other-scheme",
    });
  });

  it("notices a scheme with no credentials after it", () => {
    /**
     * Including the bare header with nothing after it at all. A client that
     * meant to present a Matrix token and sent none must not be answered by the
     * Oxy validator with "Authentication required", which names the wrong
     * problem and has sent people looking for a header that was present.
     */
    expect(readPresentedCredential(MATRIX_AUTH_SCHEME)).toEqual({ kind: "matrix-empty" });
    expect(readPresentedCredential(`${MATRIX_AUTH_SCHEME} `)).toEqual({ kind: "matrix-empty" });
    expect(readPresentedCredential(`${MATRIX_AUTH_SCHEME}   `)).toEqual({ kind: "matrix-empty" });
  });

  it("considers only the first of a repeated header", () => {
    /**
     * A request that presents two credentials must not have the friendlier one
     * chosen for it. Node surfaces a repeated header as an array; only index
     * zero is read.
     */
    expect(
      readPresentedCredential([`Bearer ${OXY_TOKEN}`, `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`]),
    ).toEqual({ kind: "other-scheme" });
  });
});

describe("a MatrixBearer credential", () => {
  it("authenticates the Oxy account the token names", async () => {
    const response = await request(api({ authenticator: authenticatorReturning(ACCEPTED) }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: OXY_USER_ID });
  });

  it("produces the same request shape a route already expects", async () => {
    /**
     * `getOxyUserId` is what every route reaches for, through
     * `getRequiredOxyUserId`. That it answers means no route has to know which
     * of the two sign-ins produced the request.
     */
    const response = await request(api({ authenticator: authenticatorReturning(ACCEPTED) }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);

    expect(response.body.userId).toBe(OXY_USER_ID);
    expect(routeHits).toBe(1);
  });

  it("passes the token through unchanged", async () => {
    await request(api({ authenticator: authenticatorReturning(ACCEPTED) }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME}   ${MATRIX_TOKEN}  `);

    expect(seenTokens).toEqual([MATRIX_TOKEN]);
  });

  it("is refused, and reaches no route, when the authenticator says no", async () => {
    const refused = authenticatorReturning({ outcome: "refused", reason: "inactive" });

    const response = await request(api({ authenticator: refused }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);

    expect(response.status).toBe(401);
    expect(routeHits).toBe(0);
  });

  it("never tells the client which check refused it", async () => {
    /**
     * Ten reasons, one body. Which of an attacker's guesses came closest is
     * exactly the feedback that makes the next guess better.
     */
    const reasons = [
      "inactive",
      "expired",
      "wrong-issuer",
      "wrong-audience",
      "missing-scope",
      "not-an-oxy-account",
    ] as const;

    const bodies = new Set<string>();
    for (const reason of reasons) {
      const response = await request(
        api({ authenticator: authenticatorReturning({ outcome: "refused", reason }) }),
      )
        .get("/api/whoami")
        .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);
      bodies.add(JSON.stringify(response.body));
    }

    expect(bodies.size).toBe(1);
  });

  it("is refused when the scheme carries no credentials", async () => {
    const response = await request(api({ authenticator: authenticatorReturning(ACCEPTED) }))
      .get("/api/whoami")
      .set("Authorization", MATRIX_AUTH_SCHEME);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("INVALID_MATRIX_TOKEN");
    expect(seenTokens).toEqual([]);
  });
});

describe("the two token types cannot be confused", () => {
  it("refuses an Oxy token presented under the Matrix scheme", async () => {
    /**
     * MAS has never heard of an Oxy JWT, so it answers `active: false` and the
     * request is refused. The fake authenticator stands in for that answer; the
     * point of the test is the ROUTING — that the Oxy validator is not reached
     * and does not get a second opinion.
     */
    const refused = authenticatorReturning({ outcome: "refused", reason: "inactive" });

    const response = await request(api({ authenticator: refused }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${OXY_TOKEN}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("INVALID_MATRIX_TOKEN");
    expect(routeHits).toBe(0);
  });

  it("refuses a MAS token presented under the Bearer scheme", async () => {
    /**
     * The real `oxy.auth()` refuses it: a MAS access token is opaque, so
     * `jwtDecode` fails and the middleware answers INVALID_TOKEN_FORMAT. No
     * network call happens, and this middleware never sees the request.
     */
    const response = await request(api({ authenticator: authenticatorReturning(ACCEPTED) }))
      .get("/api/whoami")
      .set("Authorization", `Bearer ${MATRIX_TOKEN}`);

    expect(response.status).toBe(401);
    expect(seenTokens).toEqual([]);
    expect(routeHits).toBe(0);
  });

  it("does not fall through to the Oxy validator after refusing", async () => {
    /**
     * The property that keeps the boundary from being the WEAKER of the two
     * validators. A refused MatrixBearer request is answered here; it is not
     * offered to `oxy.auth()` for a second opinion, which the distinct error
     * code proves — `oxy.auth()` would have answered MISSING_TOKEN.
     */
    const refused = authenticatorReturning({ outcome: "refused", reason: "not-an-oxy-account" });

    const response = await request(api({ authenticator: refused }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);

    expect(response.body.error).toBe("INVALID_MATRIX_TOKEN");
    expect(response.body.error).not.toBe("Unauthorized");
  });

  it("leaves a request with no Authorization header to the Oxy validator", async () => {
    const response = await request(api({ authenticator: authenticatorReturning(ACCEPTED) })).get(
      "/api/whoami",
    );

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Unauthorized");
    expect(seenTokens).toEqual([]);
  });
});

describe("when MAS cannot answer", () => {
  it("answers 503 rather than 401 when MAS is unreachable", async () => {
    /**
     * 401 would tell every client its session had ended, and a chat app answers
     * that by signing the user out. An outage must not log anybody out.
     */
    const failing = authenticatorThrowing(new MasUnreachableError("ECONNREFUSED"));

    const response = await request(api({ authenticator: failing }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);

    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBe("5");
    expect(routeHits).toBe(0);
  });

  it("answers 503 when MAS rejects this backend's own credentials", async () => {
    const failing = authenticatorThrowing(new MasCredentialError(401));

    const response = await request(api({ authenticator: failing }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);

    expect(response.status).toBe(503);
    expect(routeHits).toBe(0);
  });

  it("tells the client nothing about which upstream failure it was", async () => {
    const unreachable = await request(
      api({ authenticator: authenticatorThrowing(new MasUnreachableError("ECONNREFUSED")) }),
    )
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);
    const credentials = await request(
      api({ authenticator: authenticatorThrowing(new MasCredentialError(401)) }),
    )
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);

    expect(unreachable.body).toEqual(credentials.body);
  });

  it("answers 502 when MAS returns something unparseable", async () => {
    const failing = authenticatorThrowing(new MasProtocolError("the body was not JSON"));

    const response = await request(api({ authenticator: failing }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);

    expect(response.status).toBe(502);
    expect(routeHits).toBe(0);
  });

  it("answers 500 and authenticates nobody when this middleware itself breaks", async () => {
    const failing = authenticatorThrowing(new Error("something nobody predicted"));

    const response = await request(api({ authenticator: failing }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);

    expect(response.status).toBe(500);
    expect(routeHits).toBe(0);
  });
});

describe("a deployment that accepts no Matrix token", () => {
  it("refuses the scheme with a reason that names the real problem", async () => {
    const response = await request(api({ config: DISABLED_CONFIG }))
      .get("/api/whoami")
      .set("Authorization", `${MATRIX_AUTH_SCHEME} ${MATRIX_TOKEN}`);

    expect(response.status).toBe(401);
    expect(response.body.code).toBe("MATRIX_AUTH_NOT_CONFIGURED");
    expect(routeHits).toBe(0);
  });

  it("hands a Bearer credential to the Oxy validator, whatever the verdict", async () => {
    /**
     * The promise of this change is that the Matrix middleware does not touch a
     * `Bearer` request: it reaches the Oxy validator and gets the Oxy verdict.
     * On the fixed core Allo now rides (>= 20.1.0) that verdict is a REFUSAL for
     * this token — `OXY_TOKEN` carries no `sessionId`, and a session-less user
     * token is no longer authenticated on its claims. The property under test is
     * the routing, not the verdict: the request is answered by the Oxy path
     * (`Unauthorized`), never by this middleware (which would send a `MATRIX_*`
     * code), and never reaches the route.
     */
    const response = await request(api({ config: DISABLED_CONFIG }))
      .get("/api/whoami")
      .set("Authorization", `Bearer ${OXY_TOKEN}`);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Unauthorized");
    expect(routeHits).toBe(0);
  });

  it("leaves an unauthenticated request exactly as it was", async () => {
    const response = await request(api({ config: DISABLED_CONFIG })).get("/api/whoami");

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Unauthorized");
  });

  it("leaves an unparseable Bearer credential to the Oxy validator", async () => {
    /**
     * `createOxyAuthMiddleware` resolves the session optionally and then guards
     * with `requireOxyAuth`, so every Oxy refusal — missing, malformed or
     * expired — arrives as the same `Unauthorized` body. That is the shape a
     * MatrixBearer refusal is contrasted against above.
     */
    const response = await request(api({ config: DISABLED_CONFIG }))
      .get("/api/whoami")
      .set("Authorization", "Bearer not-a-jwt-at-all");

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Unauthorized");
  });
});

describe("the @oxyhq/core auth bypass is closed on the version Allo rides", () => {
  it("refuses a FORGED, UNSIGNED Oxy JWT instead of authenticating it", async () => {
    /**
     * ## This test was a tripwire, and it just tripped — read before touching it
     *
     * On the core Allo used to ship (`@oxyhq/core@17.0.2`), `oxy.auth()` decoded
     * the bearer JWT with `jwtDecode`, which verifies NOTHING, and then — for a
     * payload carrying no `sessionId` — trusted the `userId` claim outright. The
     * token below, whose signature is a made-up string, authenticated as whoever
     * it named: an account takeover on `api.allo.you` as deployed.
     *
     * `@oxyhq/core@20.1.0` fixed it at the source — a session-less user token is
     * refused (`SESSION_REQUIRED`) and never reaches the local-claims branch —
     * and this migration puts Allo on that line. So the forged token is now
     * refused: it arrives through the Oxy path's optional-auth + `requireOxyAuth`
     * as an ordinary `Unauthorized`, and the route is never reached.
     *
     * Kept as a REGRESSION LOCK rather than deleted: if a future change ever
     * drops Allo back onto a vulnerable core, this goes red at the exact
     * assertion, with this comment next to it.
     *
     * The Matrix path never had this branch to begin with: a MAS token is opaque
     * and is checked against MAS on every request inside a bounded window, so
     * there is no local-claims path for the same mistake to be made in.
     */
    const forged = [
      Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ userId: "aaaaaaaaaaaaaaaaaaaaaaaa", exp: 4_000_000_000 })).toString(
        "base64url",
      ),
      "AAAAcompletely-invented-signature",
    ].join(".");

    const response = await request(api({ authenticator: authenticatorReturning(ACCEPTED) }))
      .get("/api/whoami")
      .set("Authorization", `Bearer ${forged}`);

    expect(response.status).toBe(401);
    expect(response.body.error).toBe("Unauthorized");
    expect(routeHits).toBe(0);
  });
});
