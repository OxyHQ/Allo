import type { RequestHandler } from "express";
import type { OxyAuthRequest } from "@oxyhq/core/server";

import { matrixAuthConfig, type MatrixAuthConfig } from "../config/matrixAuth";
import {
  MasCredentialError,
  MasProtocolError,
  MasUnreachableError,
} from "../services/auth/masIntrospection";
import {
  createMatrixTokenAuthenticator,
  type MatrixTokenAuthenticator,
} from "../services/auth/matrixTokenAuthenticator";
import { logger } from "../utils/logger";

/**
 * Accepting a Matrix Authentication Service token where an Oxy token used to be
 * the only option.
 *
 * ## How a request says which token it is carrying
 *
 * By the **HTTP authentication scheme**, and by nothing else:
 *
 *     Authorization: Bearer <oxy access token>            ← unchanged, the default
 *     Authorization: MatrixBearer <MAS access token>      ← this middleware
 *
 * The alternative — one `Bearer` header and a side channel such as
 * `X-Allo-Token-Issuer` saying which kind it is — was rejected for two reasons.
 * The first is that a side header can be separated from the credential it
 * describes: any proxy, CDN or client library that drops an unrecognised header
 * turns a MAS request into an Oxy one, and the credential and its issuer must
 * travel together or not at all. The second is that RFC 7235 already put the
 * name of the authentication framework in front of the credentials, which is
 * exactly this question, and inventing a second place to answer it means two
 * places that can disagree.
 *
 * ## Why the two cannot be confused
 *
 * Three separate reasons, and each alone would be enough:
 *
 * 1. **The prefixes are disjoint.** `@oxyhq/core`'s `oxy.auth()` extracts a
 *    token only from a header starting with the exact string `"Bearer "`; a
 *    `MatrixBearer` header does not, so it is invisible to the Oxy validator —
 *    a structural property of the composition, not a check anybody has to
 *    remember to write. `__tests__/middleware/matrixAuth.test.ts` pins it.
 * 2. **There is no fall-through.** A request that declares `MatrixBearer` is
 *    answered by this middleware and never continues to the Oxy one, whatever
 *    the outcome. A chain that tried the other validator after a refusal would
 *    make every token's security the WEAKER of the two.
 * 3. **Neither validator can be fooled by the other's token.** An Oxy token
 *    presented as `MatrixBearer` is unknown to MAS, which answers
 *    `active: false`. A MAS access token presented as `Bearer` is opaque, so
 *    `jwtDecode` fails and `oxy.auth()` refuses it. Both are tested.
 *
 * So the scheme is client-controlled, and that is fine: it selects a validator,
 * it never grants anything. Mis-declaring a token can only produce a 401.
 *
 * ## Why it produces the same `req.user` as the Oxy path
 *
 * `createOxyAuthMiddleware` short-circuits when a previous middleware has
 * already resolved a user, so setting `req.userId` and `req.user` here is all
 * that is needed for every existing route to work unchanged — none of them can
 * tell which sign-in produced the request, and none of them should have to.
 *
 * ## What this does NOT cover
 *
 * The Socket.IO handshake. `server.ts` authenticates sockets with
 * `oxy.authSocket()`, which is untouched, so a MAS token cannot open a
 * websocket. That is not an oversight: the realtime namespace belongs to the
 * legacy transport, and the Matrix path replaces it with `/sync` rather than
 * authenticating into it.
 *
 * The per-user rate limiter is also untouched, and it runs BEFORE this
 * middleware because `createOxyRateLimit` resolves its own session and
 * overwrites `req.userId` with `null` when it finds no `Bearer` header. A
 * MatrixBearer request is therefore counted against the anonymous per-IP
 * bucket rather than a per-user one. Nothing sends MatrixBearer today, so
 * nothing is affected yet; it has to be resolved in `@oxyhq/core` (by making
 * the limiter's session resolution idempotent, which its own doc comment
 * already claims it is) before the frontend switches over.
 */

/**
 * The scheme. Compared case-insensitively, because RFC 7235 says schemes are
 * case-insensitive and a client that sends `matrixbearer` is not attacking us.
 */
export const MATRIX_AUTH_SCHEME = "MatrixBearer";

const MATRIX_AUTH_SCHEME_LOWERCASE = MATRIX_AUTH_SCHEME.toLowerCase();

/** What the `Authorization` header of an incoming request turned out to be. */
type PresentedCredential =
  | { readonly kind: "other-scheme" }
  | { readonly kind: "matrix"; readonly token: string }
  | { readonly kind: "matrix-empty" };

/**
 * Reads the `Authorization` header, and decides only whether it is ours.
 *
 * `other-scheme` covers an absent header, a `Bearer` one, and anything else.
 * All three mean the same thing here: not this middleware's business.
 */
export function readPresentedCredential(
  rawHeader: string | string[] | undefined,
): PresentedCredential {
  /**
   * Node allows a repeated header to arrive as an array. Only the first is
   * considered — concatenating them, or searching them for one that parses,
   * would let a request present two credentials and have the friendlier one
   * chosen for it.
   */
  const header = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (typeof header !== "string") return { kind: "other-scheme" };

  /**
   * The scheme ends at the first run of whitespace, or at the end of the header
   * when it carries nothing else. Both are ours to answer: a bare
   * `Authorization: MatrixBearer` is a client that meant to present a Matrix
   * token and sent none, and letting it fall through to the Oxy validator would
   * answer it with "Authentication required", which names the wrong problem.
   */
  const separator = header.search(/\s/);
  const scheme = separator < 0 ? header : header.slice(0, separator);
  if (scheme.toLowerCase() !== MATRIX_AUTH_SCHEME_LOWERCASE) return { kind: "other-scheme" };

  const token = separator < 0 ? "" : header.slice(separator + 1).trim();
  return token.length === 0 ? { kind: "matrix-empty" } : { kind: "matrix", token };
}

/** The one body a refused request gets, whatever the reason. */
const UNAUTHORIZED_BODY = {
  error: "INVALID_MATRIX_TOKEN",
  message: "Matrix access token is not valid",
  code: "INVALID_MATRIX_TOKEN",
} as const;

/**
 * The one body an upstream failure gets.
 *
 * Deliberately the same for "MAS is down" and "MAS rejected OUR credentials",
 * because a client can do nothing different about them and an unauthenticated
 * caller has no business learning which of the two it is. The two are told
 * apart in the log, at different severities, which is where the answer is
 * actually needed.
 */
const UNAVAILABLE_BODY = {
  error: "MATRIX_AUTH_UNAVAILABLE",
  message: "Matrix authentication is temporarily unavailable",
  code: "MATRIX_AUTH_UNAVAILABLE",
} as const;

/** How long a client is asked to wait after a 503. Seconds. */
const RETRY_AFTER_SECONDS = 5;

export interface MatrixAuthMiddlewareOptions {
  readonly config?: MatrixAuthConfig;
  readonly authenticator?: MatrixTokenAuthenticator;
}

export function createMatrixAuthMiddleware(
  options: MatrixAuthMiddlewareOptions = {},
): RequestHandler {
  const config = options.config ?? matrixAuthConfig();

  /**
   * Built once, and only when the path is enabled: the authenticator owns the
   * introspection cache, so one per process is what makes the cache worth
   * having. A disabled deployment builds nothing.
   */
  const authenticator: MatrixTokenAuthenticator | undefined = config.enabled
    ? (options.authenticator ?? createMatrixTokenAuthenticator({ config }))
    : options.authenticator;

  return (req, res, next) => {
    const presented = readPresentedCredential(req.headers.authorization);

    if (presented.kind === "other-scheme") {
      next();
      return;
    }

    if (!config.enabled || authenticator === undefined) {
      /**
       * The scheme was used against a deployment that accepts no MAS token.
       * Refused rather than passed through: falling through would answer with
       * the Oxy middleware's "Access token required", which points at the wrong
       * problem and has sent people looking for a missing header that was
       * present all along.
       */
      res.status(401).json({
        error: "MATRIX_AUTH_NOT_CONFIGURED",
        message: "This deployment does not accept Matrix access tokens",
        code: "MATRIX_AUTH_NOT_CONFIGURED",
      });
      return;
    }

    if (presented.kind === "matrix-empty") {
      res.status(401).json(UNAUTHORIZED_BODY);
      return;
    }

    const resolvedAuthenticator = authenticator;

    /**
     * Started and deliberately not awaited: an Express handler is synchronous,
     * and every path inside either answers the response or calls `next()`. The
     * `void` says the floating promise is intentional rather than forgotten.
     */
    void authenticate(presented.token);
    return;

    async function authenticate(token: string): Promise<void> {
      try {
        const result = await resolvedAuthenticator.authenticate(token);

        if (result.outcome === "refused") {
          /**
           * The reason is logged and the client is told nothing beyond "no".
           * Which check refused a guess is a hint about how to make the next
           * one better.
           */
          logger.warn("[MatrixAuth] access token refused", { reason: result.reason });
          res.status(401).json(UNAUTHORIZED_BODY);
          return;
        }

        /**
         * The same two fields `oxy.auth()` sets, so `createOxyAuthMiddleware`
         * downstream finds a resolved session and lets the request through
         * without re-checking anything, and so no route can tell the two
         * sign-ins apart.
         *
         * `accessToken` is deliberately NOT set. The Oxy path puts the Oxy
         * bearer there for code that calls Oxy as the user; a MAS token is not
         * an Oxy credential, and leaving the field empty makes any such caller
         * fail visibly instead of sending the wrong token to the wrong service.
         */
        const authRequest: OxyAuthRequest = req;
        authRequest.userId = result.oxyUserId;
        authRequest.user = { id: result.oxyUserId };
        next();
      } catch (error) {
        respondToUpstreamFailure(error);
      }
    }

    function respondToUpstreamFailure(error: unknown): void {
      if (error instanceof MasCredentialError) {
        /**
         * `error` and not `warn`: this is not a user's problem, it is this
         * deployment's client id or secret being wrong, and while it lasts NO
         * MAS token is accepted at all. The message names the variables; the
         * secret itself is never in it.
         */
        logger.error("[MatrixAuth] MAS rejected this backend's introspection credentials", error);
        res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
        res.status(503).json(UNAVAILABLE_BODY);
        return;
      }

      if (error instanceof MasUnreachableError) {
        logger.warn("[MatrixAuth] MAS unreachable", { reason: error.message });
        res.setHeader("Retry-After", String(RETRY_AFTER_SECONDS));
        res.status(503).json(UNAVAILABLE_BODY);
        return;
      }

      if (error instanceof MasProtocolError) {
        /**
         * 502 rather than 503: MAS answered, and what it said was not RFC 7662.
         * A different status because it is a different day's problem — an
         * upgrade that changed a response shape, not an outage.
         */
        logger.error("[MatrixAuth] MAS returned an unusable introspection response", error);
        res.status(502).json(UNAVAILABLE_BODY);
        return;
      }

      /**
       * Nothing else is expected, so nothing else is interpreted. A 500 that
       * authenticates nobody is the correct outcome for a bug in this file.
       */
      logger.error("[MatrixAuth] unexpected failure while authenticating a Matrix token", error);
      res.status(500).json({
        error: "MATRIX_AUTH_INTERNAL_ERROR",
        message: "Internal authentication error",
        code: "MATRIX_AUTH_INTERNAL_ERROR",
      });
    }
  };
}
