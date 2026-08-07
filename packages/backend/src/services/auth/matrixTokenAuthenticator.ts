import { createHash } from "crypto";

import { matrixAuthConfig, type MatrixAuthConfig } from "../../config/matrixAuth";
import {
  MatrixIdentityError,
  oxyAccountIdFromMatrixUserId,
  oxyUserIdFromMatrixLocalpart,
} from "../bridges/matrixIdentity";
import {
  introspectAccessToken,
  type HttpFetch,
  type MasIntrospectionResponse,
} from "./masIntrospection";

/**
 * Turning a Matrix Authentication Service access token into the Oxy account it
 * names, or into the reason it names none.
 *
 * `masIntrospection.ts` asks the question. This module decides what the answer
 * means, and remembers it for a bounded moment.
 *
 * ## Every refusal has its own name
 *
 * Not for the client's benefit — the middleware collapses them all into one 401
 * body, because telling a caller WHY their token was refused tells an attacker
 * which of their guesses was closest. They are named for the operator's: eight
 * distinguishable reasons in a log line and in a test, so that "nobody can sign
 * in" can be diagnosed without a debugger, and so that each refusal has a test
 * that fails if the check that produces it is removed.
 *
 * ## What is checked beyond `active`
 *
 * `active: true` alone means "this string is a live credential at this
 * issuer" — not "this is an Allo user's Matrix session". The gap between those
 * two is where the interesting attacks live, so:
 *
 * - **Token type.** A REFRESH token introspects as active. Accepting one as a
 *   bearer credential would make a long-lived token that is only ever meant to
 *   be exchanged at the token endpoint into an API credential.
 * - **Scope.** See {@link MatrixAuthConfig.acceptedScopes}: this is the audience
 *   check for an opaque token, and it is what refuses a MAS admin token or a
 *   bare `openid` token from another client of the same issuer.
 * - **Issuer and audience**, whenever the response carries them. MAS does not
 *   send either — the binding to the issuer is that we only ever ASK the
 *   issuer, enforced at boot by `config/matrixAuth.ts` — but a response that
 *   does carry them and disagrees is refused rather than ignored.
 * - **The subject is an Oxy account.** `docs/matrix/data-model.md` §6.2 makes
 *   the MXID localpart the Oxy account id, so this direction is string
 *   arithmetic — and it is the direction that has to refuse rather than repair,
 *   because a localpart accepted here is a request authenticated as that
 *   account. A bridge ghost is not a person on this platform.
 */

/** Why a token was refused. Never sent to a client; logged and tested. */
export type MatrixTokenRefusalReason =
  | "inactive"
  | "not-yet-valid"
  | "expired"
  | "wrong-token-type"
  | "wrong-issuer"
  | "wrong-audience"
  | "missing-scope"
  | "client-not-allowed"
  | "no-subject"
  | "not-an-oxy-account";

export interface MatrixTokenAccepted {
  readonly outcome: "accepted";
  /** The Oxy account id, in the shape every route already expects. */
  readonly oxyUserId: string;
  /** The Matrix device the token was issued to, when MAS reports one. */
  readonly deviceId: string | undefined;
}

export interface MatrixTokenRefused {
  readonly outcome: "refused";
  readonly reason: MatrixTokenRefusalReason;
}

export type MatrixTokenResult = MatrixTokenAccepted | MatrixTokenRefused;

export interface MatrixTokenAuthenticator {
  /**
   * Resolves to the account the token names, or to the reason it names none.
   *
   * THROWS — rather than resolving to a refusal — when the failure says nothing
   * about the token: MAS unreachable, MAS rejecting this backend's own
   * credentials, MAS answering something unparseable. See the error classes in
   * `masIntrospection.ts` for why those must not collapse into "invalid token".
   */
  authenticate(token: string): Promise<MatrixTokenResult>;
}

/**
 * How many distinct tokens may be remembered at once.
 *
 * A cache keyed by an attacker-supplied string is a memory-exhaustion primitive
 * unless it is bounded: a spray of ten million invented tokens would otherwise
 * be ten million entries. Ten thousand is far more than the concurrent devices
 * one instance serves inside a 30-second window, and eviction is oldest-first.
 */
const MAX_CACHE_ENTRIES = 10_000;

/**
 * How long a REFUSAL is remembered, at most.
 *
 * Shorter than the positive window, and separate from it, because the two have
 * opposite risks. A stale acceptance is a revoked token that still works; a
 * stale refusal is a valid token that does not, which the user cannot clear by
 * retrying. Five seconds is enough to blunt a spray of one guessed token
 * against MAS and short enough that no legitimate client notices it.
 */
const NEGATIVE_CACHE_SECONDS = 5;

interface CacheEntry {
  readonly expiresAtMs: number;
  readonly result: MatrixTokenResult;
}

export interface MatrixTokenAuthenticatorOptions {
  readonly config?: MatrixAuthConfig;
  readonly httpFetch?: HttpFetch;
  /** Injectable clock. `Date.now`, except in the tests that pin the cache. */
  readonly now?: () => number;
}

/**
 * The cache key.
 *
 * SHA-256 of the token, so that a heap dump, a debugger or an accidental
 * iteration over the map cannot yield a working credential. The digest is never
 * logged either — it is a stable identifier for one session, which is exactly
 * the kind of thing that turns an operational log into a tracking log.
 */
function cacheKeyFor(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** RFC 8414 issuers differ only by a trailing slash far too often to care. */
function normalizeIssuer(issuer: string): string {
  return issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
}

/**
 * Whether the introspected token is an ACCESS token.
 *
 * RFC 7662 makes `token_type` optional, and an absent one is not evidence of
 * anything, so it is accepted. A present one that says something else is
 * refused: MAS spells an access token `access_token` and RFC 6750 spells the
 * same thing `Bearer`, and both are the same claim about the same token.
 */
function isAccessTokenType(tokenType: string | undefined): boolean {
  if (tokenType === undefined) return true;
  const normalized = tokenType.trim().toLowerCase();
  return normalized === "bearer" || normalized === "access_token";
}

/** Whether the token's scope contains at least one scope we accept. */
function hasAcceptedScope(scope: string | undefined, accepted: readonly string[]): boolean {
  if (scope === undefined) return false;
  const granted = new Set(scope.split(/\s+/).filter((entry) => entry.length > 0));
  return accepted.some((candidate) => granted.has(candidate));
}

function audienceContains(audience: string | readonly string[], expected: string): boolean {
  return typeof audience === "string" ? audience === expected : audience.includes(expected);
}

/**
 * The Oxy account the response names.
 *
 * `username` and nothing else, deliberately. MAS reports the Matrix localpart
 * there, and §6.2 makes the localpart the Oxy account id; `sub` is MAS's own
 * internal subject, which is a different namespace and is not an Oxy id. A
 * fallback from one to the other would be an authentication boundary guessing
 * which namespace it is in, and getting that wrong once is an account takeover.
 *
 * A `username` that already carries the `@` sigil is treated as a full MXID and
 * has to belong to OUR homeserver, which is one more thing that cannot be true
 * by accident.
 */
function oxyAccountFor(response: MasIntrospectionResponse): string | undefined {
  const username = response.username?.trim();
  if (username === undefined || username.length === 0) return undefined;

  if (!username.startsWith("@")) {
    return oxyUserIdFromMatrixLocalpart(username);
  }

  try {
    return oxyAccountIdFromMatrixUserId(username);
  } catch (error) {
    /**
     * Only `MatrixIdentityError`, which is "ALLO_MATRIX_SERVER_NAME is not
     * configured, so no MXID can be judged". Refusing is the only answer
     * available: without a server name there is no way to tell our homeserver's
     * users from anybody else's. Anything else rethrows, because an unexpected
     * error inside an authentication decision must not read as a refusal.
     */
    if (error instanceof MatrixIdentityError) return undefined;
    throw error;
  }
}

/** Applies every rule to one introspection response. Pure; no I/O, no cache. */
export function evaluateIntrospection(
  response: MasIntrospectionResponse,
  config: MatrixAuthConfig,
  nowSeconds: number,
): MatrixTokenResult {
  if (!response.active) {
    return { outcome: "refused", reason: "inactive" };
  }
  if (!isAccessTokenType(response.token_type)) {
    return { outcome: "refused", reason: "wrong-token-type" };
  }
  if (response.nbf !== undefined && nowSeconds < response.nbf) {
    return { outcome: "refused", reason: "not-yet-valid" };
  }
  /**
   * `<=` and not `<`: a token is dead at the second it expires. MAS would
   * normally have answered `active: false` already, so reaching this means a
   * clock disagreement between MAS and this process, and the safe direction of
   * a disagreement about expiry is to expire.
   */
  if (response.exp !== undefined && response.exp <= nowSeconds) {
    return { outcome: "refused", reason: "expired" };
  }
  if (
    response.iss !== undefined &&
    normalizeIssuer(response.iss) !== normalizeIssuer(config.issuer)
  ) {
    return { outcome: "refused", reason: "wrong-issuer" };
  }
  if (config.expectedAudience !== undefined) {
    if (response.aud === undefined || !audienceContains(response.aud, config.expectedAudience)) {
      return { outcome: "refused", reason: "wrong-audience" };
    }
  }
  if (!hasAcceptedScope(response.scope, config.acceptedScopes)) {
    return { outcome: "refused", reason: "missing-scope" };
  }
  if (config.allowedClientIds.length > 0) {
    if (response.client_id === undefined || !config.allowedClientIds.includes(response.client_id)) {
      return { outcome: "refused", reason: "client-not-allowed" };
    }
  }

  const username = response.username?.trim();
  if (username === undefined || username.length === 0) {
    return { outcome: "refused", reason: "no-subject" };
  }

  const oxyUserId = oxyAccountFor(response);
  if (oxyUserId === undefined) {
    return { outcome: "refused", reason: "not-an-oxy-account" };
  }

  return { outcome: "accepted", oxyUserId, deviceId: response.device_id };
}

/**
 * How long this result may be reused, in milliseconds. Zero means "do not
 * cache", which is what an already-expired token gets.
 */
function cacheWindowMs(
  result: MatrixTokenResult,
  response: MasIntrospectionResponse,
  config: MatrixAuthConfig,
  nowMs: number,
): number {
  if (result.outcome === "refused") {
    return Math.min(config.cacheSeconds, NEGATIVE_CACHE_SECONDS) * 1000;
  }

  const ceilingMs = config.cacheSeconds * 1000;
  if (response.exp === undefined) return ceilingMs;

  /**
   * `exp` is a ceiling on top of the configured ceiling, never an extension of
   * it: a token with fifty minutes left is still re-checked every 30 seconds,
   * and a token with four seconds left is cached for four. Without the second
   * half of that, the cache would keep serving a token past its own expiry.
   */
  const untilExpiryMs = response.exp * 1000 - nowMs;
  return Math.max(0, Math.min(ceilingMs, untilExpiryMs));
}

export function createMatrixTokenAuthenticator(
  options: MatrixTokenAuthenticatorOptions = {},
): MatrixTokenAuthenticator {
  const config = options.config ?? matrixAuthConfig();
  const now = options.now ?? Date.now;
  const httpFetch = options.httpFetch;

  const cache = new Map<string, CacheEntry>();
  /**
   * One introspection per token per burst.
   *
   * Opening a screen fires several API calls at once, and without this each of
   * them would be its own round trip to MAS for the same answer. Callers that
   * arrive while one is in flight await the same promise. A rejected promise is
   * shared too, and that is correct: an outage should not become N retries.
   */
  const inFlight = new Map<string, Promise<MatrixTokenResult>>();

  function remember(key: string, result: MatrixTokenResult, windowMs: number): void {
    if (windowMs <= 0) return;
    /**
     * Insertion order is eviction order. `Map` iterates in insertion order and
     * an entry is never re-inserted while it is live, so the first key is the
     * oldest — which is the one whose answer is closest to being re-asked
     * anyway.
     */
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done === true) break;
      cache.delete(oldest.value);
    }
    cache.set(key, { expiresAtMs: now() + windowMs, result });
  }

  return {
    async authenticate(token: string): Promise<MatrixTokenResult> {
      const key = cacheKeyFor(token);

      const cached = cache.get(key);
      if (cached !== undefined) {
        if (cached.expiresAtMs > now()) return cached.result;
        cache.delete(key);
      }

      const pending = inFlight.get(key);
      if (pending !== undefined) return await pending;

      const request = (async (): Promise<MatrixTokenResult> => {
        const response = await introspectAccessToken(token, config, httpFetch);
        const nowMs = now();
        const result = evaluateIntrospection(response, config, Math.floor(nowMs / 1000));
        remember(key, result, cacheWindowMs(result, response, config, nowMs));
        return result;
      })();

      inFlight.set(key, request);
      try {
        return await request;
      } finally {
        /**
         * Cleared whether the call succeeded or threw. A failed introspection is
         * deliberately not cached at all — MAS being down is not evidence about
         * a token — so the next request must be free to ask again.
         */
        inFlight.delete(key);
      }
    },
  };
}
