import * as z from "zod";

import type { MatrixAuthConfig } from "../../config/matrixAuth";

/**
 * Asking Matrix Authentication Service whether an access token is still live.
 *
 * RFC 7662 token introspection, and nothing more: this module makes the call,
 * refuses to believe an answer it cannot parse, and hands the result to
 * `matrixTokenAuthenticator.ts`, which decides what the answer MEANS. The split
 * is deliberate — one module that can be tested against a fake HTTP layer, and
 * one that can be tested with no HTTP layer at all.
 *
 * ## A MAS access token is opaque
 *
 * It is not a JWT. There is no signature to check locally and no claim to read,
 * so there is no fast path: the only way to learn anything about the token is to
 * ask the server that minted it. That is why the caching in
 * `matrixTokenAuthenticator.ts` is not an optimisation but a requirement.
 *
 * ## Nothing here is ever logged
 *
 * Not the token, not the response, not the client secret. An introspection
 * response names a user, a device and a scope, so a log line carrying one is a
 * session log with a credential attached to it. Callers get a typed error whose
 * message says what kind of failure it was and nothing about who it happened to.
 */

/**
 * An introspection answer, as far as this module is willing to parse it.
 *
 * Only `active` is required, which is RFC 7662's own rule: a response for an
 * unknown or revoked token is `{"active": false}` and carries nothing else.
 * Every other field is validated if present and dropped if not — `passthrough`
 * is deliberately not used, so a field MAS adds later cannot reach a decision
 * without somebody adding it here on purpose.
 */
const introspectionResponseSchema = z.object({
  active: z.boolean(),
  scope: z.string().optional(),
  client_id: z.string().optional(),
  username: z.string().optional(),
  token_type: z.string().optional(),
  exp: z.number().int().optional(),
  iat: z.number().int().optional(),
  nbf: z.number().int().optional(),
  sub: z.string().optional(),
  aud: z.union([z.string(), z.array(z.string())]).optional(),
  iss: z.string().optional(),
  jti: z.string().optional(),
  device_id: z.string().optional(),
});

export type MasIntrospectionResponse = z.infer<typeof introspectionResponseSchema>;

/**
 * MAS could not be reached, or did not answer in time, or answered 5xx.
 *
 * Distinct from every other failure because it says nothing at all about the
 * token. Treating it as "invalid token" would sign every user out of every
 * device the moment MAS restarts, so the middleware answers 503 for this one
 * and 401 for the rest.
 */
export class MasUnreachableError extends Error {
  constructor(reason: string) {
    super(`Matrix Authentication Service could not be reached: ${reason}`);
    this.name = "MasUnreachableError";
  }
}

/**
 * MAS refused OUR credentials, or refused the request itself.
 *
 * A 401 or 403 here is this backend's client id and secret being wrong, not the
 * user's token — MAS answers an unknown token with `200 {"active": false}`. The
 * distinction is the difference between one user re-authenticating and every
 * user being signed out by a bad deploy, so it gets its own error and its own
 * loud log at the point of use.
 */
export class MasCredentialError extends Error {
  constructor(readonly status: number) {
    super(
      `Matrix Authentication Service rejected this backend's introspection credentials (HTTP ${status}). ` +
        "Check ALLO_MAS_INTROSPECTION_CLIENT_ID and ALLO_MAS_INTROSPECTION_CLIENT_SECRET, and that the " +
        "client is allowed to introspect on the MAS side",
    );
    this.name = "MasCredentialError";
  }
}

/** MAS answered, but not with something RFC 7662 describes. */
export class MasProtocolError extends Error {
  constructor(reason: string) {
    super(`Matrix Authentication Service returned an unusable introspection response: ${reason}`);
    this.name = "MasProtocolError";
  }
}

/**
 * The slice of `fetch` this module uses.
 *
 * Narrowed to a function type rather than taken from the global so a test can
 * supply one without touching `globalThis`, and so the compiler checks the two
 * arguments that matter at every call site.
 */
export type HttpFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * `client_secret_basic`, encoded the way RFC 6749 §2.3.1 requires.
 *
 * The id and the secret are form-urlencoded BEFORE they are joined with a colon
 * and base64'd. Skipping that step works right up until a secret contains a
 * colon or a non-ASCII character, at which point every introspection fails with
 * a 401 that reads as "wrong secret" — which it is not.
 */
function basicAuthorization(clientId: string, clientSecret: string): string {
  const encoded = `${formUrlEncode(clientId)}:${formUrlEncode(clientSecret)}`;
  return `Basic ${Buffer.from(encoded, "utf8").toString("base64")}`;
}

function formUrlEncode(value: string): string {
  const prefix = "v=";
  return new URLSearchParams({ v: value }).toString().slice(prefix.length);
}

/**
 * One introspection round trip. No caching, no interpretation, no retry.
 *
 * No retry on purpose: this sits inside a user's request, a retry would double
 * the latency of an outage rather than hide it, and the caller already has the
 * right answer for a failed call — refuse, and let the client try again.
 */
export async function introspectAccessToken(
  token: string,
  config: MatrixAuthConfig,
  httpFetch: HttpFetch = globalThis.fetch,
): Promise<MasIntrospectionResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  let response: Response;
  try {
    response = await httpFetch(config.introspectionUrl, {
      method: "POST",
      headers: {
        authorization: basicAuthorization(config.clientId, config.clientSecret),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        token,
        token_type_hint: "access_token",
      }).toString(),
      signal: controller.signal,
    });
  } catch (error) {
    /**
     * The caught error is named by its class and never by its message. A fetch
     * failure's text can carry the request, and the request body is the user's
     * access token.
     */
    throw new MasUnreachableError(error instanceof Error ? error.name : "request failed");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new MasCredentialError(response.status);
  }
  if (!response.ok) {
    throw new MasUnreachableError(`HTTP ${response.status}`);
  }

  let rawBody: string;
  try {
    rawBody = await response.text();
  } catch (error) {
    throw new MasUnreachableError(
      `response body could not be read (${error instanceof Error ? error.name : "unknown"})`,
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new MasProtocolError("the body was not JSON");
  }

  const parsed = introspectionResponseSchema.safeParse(payload);
  if (!parsed.success) {
    /**
     * Only the field paths and zod's own messages, never the values. An
     * introspection body names a user and a device even when it is malformed.
     */
    throw new MasProtocolError(
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; "),
    );
  }

  return parsed.data;
}
