import * as z from "zod";

/**
 * Accepting a Matrix Authentication Service access token at `api.allo.you`.
 *
 * ## Why this exists
 *
 * Allo signs a person in twice today: once to Oxy for this backend, and once
 * through Matrix Authentication Service for chat. Two tokens for one person is
 * two identities that have to be kept pointing at the same account, and the
 * account-switch bug that shipped in #104 is what happens when they stop. The
 * end state is one sign-in — MAS — and this module is the half that lets this
 * backend believe the token it produces.
 *
 * ## Same shape as `config/push.ts` and `config/bridges.ts`
 *
 * Validated with zod ONCE, memoised, frozen. Here the reason is sharper than in
 * either of those: every variable below decides whether a stranger's token is
 * accepted as a user, so a typo that reads as `undefined` at the point of use
 * would not degrade a feature, it would open an authentication boundary. All of
 * it or none of it, checked in `superRefine`, and a deployment that asks for
 * half does not boot.
 *
 * ## Why there is no OIDC discovery
 *
 * The introspection endpoint could be discovered from
 * `${issuer}/.well-known/openid-configuration`, and that is how a general OAuth
 * client would find it. It is configured explicitly here instead, for two
 * reasons that both matter on an authentication path:
 *
 * 1. Discovery is a network call, so it is a way for authentication to fail
 *    that has nothing to do with the token being presented, and a cache of the
 *    result is one more thing that can be stale at the wrong moment.
 * 2. The only property discovery would establish — that the endpoint answering
 *    introspection belongs to the issuer we pinned — is checked HERE, at boot,
 *    with no network: {@link ALLO_MAS_INTROSPECTION_URL} must be same-origin
 *    with {@link ALLO_MAS_ISSUER}. A process configured to ask a stranger about
 *    our users' tokens does not start.
 *
 * That same-origin rule is the whole of Allo's issuer verification, and it is
 * deliberate rather than a shortcut: MAS's introspection response carries no
 * `iss` and no `aud` (RFC 7662 makes both optional). There is nothing in the
 * answer to check, so the guarantee has to come from WHERE THE QUESTION WAS
 * ASKED. `services/auth/masIntrospection.ts` still checks `iss` and `aud` when
 * a response does carry them, so a future MAS that starts emitting them is
 * checked rather than ignored — but nothing rests on that today.
 */

/**
 * The scopes that say a token is a Matrix client-API token.
 *
 * This is Allo's audience check, and it needs the explanation. An opaque MAS
 * access token has no `aud`; under MSC2967 what a Matrix access token is FOR is
 * expressed as scope, and `…client:api:*` is "the Matrix client-server API on
 * this homeserver". Requiring it refuses three things that would otherwise walk
 * straight through an `active: true`: a MAS admin token, a bare `openid` token
 * minted by some other client of the same issuer, and a device-scoped token
 * carrying no API grant at all.
 *
 * Two spellings, and any one of them is enough. MAS emitted the
 * `org.matrix.msc2967` unstable prefix before the MSC stabilised and emits the
 * short form after; which one arrives is a property of the deployed MAS
 * version, not of the token's meaning, and pinning the wrong one is an outage
 * on the day MAS is upgraded.
 */
const DEFAULT_ACCEPTED_SCOPES = [
  "urn:matrix:org.matrix.msc2967.client:api:*",
  "urn:matrix:client:api:*",
] as const;

/**
 * How long an introspection answer may be reused, at most.
 *
 * MAS answers with the token's `exp`, which for a Matrix access token is hours
 * away, and caching for that long would mean a signed-out device keeps working
 * until its token would have expired anyway — the cache would have UNDONE
 * revocation. So `exp` is a ceiling and this is the real bound: after 30
 * seconds the answer is asked for again, so a revoked token stops working
 * within 30 seconds of the revocation everywhere, on every instance, with no
 * invalidation channel to build or to get wrong.
 *
 * Thirty seconds and not five: a chat client makes several API calls per
 * screen, so the window's job is to collapse a burst of them into one round
 * trip, and a burst is seconds long. Not five minutes: that is long enough for
 * somebody to notice a stolen phone, sign the device out, and still be watched.
 */
const DEFAULT_CACHE_SECONDS = 30;

/** The ceiling on the ceiling. See {@link DEFAULT_CACHE_SECONDS}. */
const MAXIMUM_CACHE_SECONDS = 300;

/** How long MAS gets to answer before the request is abandoned. */
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * The shortest introspection client secret this deployment will accept.
 *
 * The secret is what lets this backend ask MAS about anybody's token, so it is
 * a credential over the whole user base. Thirty-two characters is the same
 * floor the push gateway secrets use, and `openssl rand -hex 32` clears it.
 */
const MINIMUM_CLIENT_SECRET_LENGTH = 32;

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim().length === 0 ? undefined : value;

const optionalString = (minimumLength = 1) =>
  z.preprocess(emptyAsUndefined, z.string().trim().min(minimumLength).optional());

/**
 * An OAuth 2.0 issuer identifier: absolute, https, no query and no fragment.
 *
 * http is refused rather than allowed for local development. A token is a
 * bearer credential and introspecting it over cleartext hands it to the
 * network; there is no development convenience worth an environment where that
 * is possible, and a local MAS can be given a certificate.
 */
const issuerUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => new URL(value).protocol === "https:", "must use https://")
  .refine((value) => {
    const url = new URL(value);
    return url.search.length === 0 && url.hash.length === 0;
  }, "must carry no query string and no fragment")
  .refine((value) => {
    const url = new URL(value);
    return url.username.length === 0 && url.password.length === 0;
  }, "must carry no credentials — the client secret goes in ALLO_MAS_INTROSPECTION_CLIENT_SECRET");

/** A comma-separated list, trimmed, with empty entries dropped. */
const stringList = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .trim()
    .transform((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(z.string().min(1)).min(1))
    .optional(),
);

const cacheSeconds = z.preprocess(
  emptyAsUndefined,
  z.coerce.number().int().min(1).max(MAXIMUM_CACHE_SECONDS).default(DEFAULT_CACHE_SECONDS),
);

const timeoutMs = z.preprocess(
  emptyAsUndefined,
  z.coerce.number().int().min(500).max(30_000).default(DEFAULT_TIMEOUT_MS),
);

function buildMatrixAuthEnvSchema() {
  return z
    .object({
      ALLO_MAS_ISSUER: z.preprocess(emptyAsUndefined, issuerUrl.optional()),
      ALLO_MAS_INTROSPECTION_URL: z.preprocess(emptyAsUndefined, issuerUrl.optional()),
      ALLO_MAS_INTROSPECTION_CLIENT_ID: optionalString(),
      ALLO_MAS_INTROSPECTION_CLIENT_SECRET: optionalString(MINIMUM_CLIENT_SECRET_LENGTH),
      ALLO_MAS_ALLOWED_CLIENT_IDS: stringList,
      ALLO_MAS_ACCEPTED_SCOPES: stringList,
      ALLO_MAS_EXPECTED_AUDIENCE: optionalString(),
      ALLO_MAS_INTROSPECTION_CACHE_SECONDS: cacheSeconds,
      ALLO_MAS_INTROSPECTION_TIMEOUT_MS: timeoutMs,
    })
    .superRefine((environment, context) => {
      if (environment.ALLO_MAS_ISSUER === undefined) {
        /**
         * No issuer asked for. Not an error — it is a deployment that accepts
         * Oxy tokens only, which is every deployment today. Anything else set
         * alongside it is inert, and refusing to boot over a variable that
         * decides nothing would be worse than ignoring it.
         */
        return;
      }

      if (environment.ALLO_MAS_INTROSPECTION_URL === undefined) {
        context.addIssue({
          code: "custom",
          path: ["ALLO_MAS_INTROSPECTION_URL"],
          message:
            "is required once ALLO_MAS_ISSUER is set — without it there is no way to ask whether " +
            "a token is still live, and a token nobody can revoke is not an authentication scheme",
        });
      } else if (new URL(environment.ALLO_MAS_INTROSPECTION_URL).origin !== new URL(environment.ALLO_MAS_ISSUER).origin) {
        context.addIssue({
          code: "custom",
          path: ["ALLO_MAS_INTROSPECTION_URL"],
          message:
            "must be same-origin with ALLO_MAS_ISSUER. Asking a different host whether our users' " +
            "tokens are valid is asking a stranger to authenticate them, and because MAS returns " +
            "no `iss` in its introspection response, this check is the only thing that binds an " +
            "answer to the issuer we trust",
        });
      }

      if (environment.ALLO_MAS_INTROSPECTION_CLIENT_ID === undefined) {
        context.addIssue({
          code: "custom",
          path: ["ALLO_MAS_INTROSPECTION_CLIENT_ID"],
          message:
            "is required once ALLO_MAS_ISSUER is set — MAS answers an unauthenticated introspection " +
            "request with 400 invalid_request, so a deployment without it accepts no token at all",
        });
      }

      if (environment.ALLO_MAS_INTROSPECTION_CLIENT_SECRET === undefined) {
        context.addIssue({
          code: "custom",
          path: ["ALLO_MAS_INTROSPECTION_CLIENT_SECRET"],
          message:
            `is required once ALLO_MAS_ISSUER is set, and must be at least ${MINIMUM_CLIENT_SECRET_LENGTH} ` +
            "characters — it is the credential that lets this backend ask MAS about anybody's token",
        });
      }
    });
}

export interface MatrixAuthConfig {
  /** Whether a MAS token can be presented at all. False means Oxy tokens only. */
  readonly enabled: boolean;
  /** The OAuth 2.0 issuer identifier, exactly as MAS publishes it. */
  readonly issuer: string;
  /** RFC 7662 introspection endpoint. Same-origin with {@link issuer}. */
  readonly introspectionUrl: string;
  /** The client this backend authenticates to the introspection endpoint as. */
  readonly clientId: string;
  /** Its secret. A credential: never logged, never returned by an endpoint. */
  readonly clientSecret: string;
  /**
   * Which OAuth clients' tokens are accepted, or empty for "any client of the
   * configured issuer".
   *
   * Empty is the realistic default and it is worth being plain about why. Allo
   * registers with MAS DYNAMICALLY (`client.web.ts` posts to the registration
   * endpoint), so the `client_id` differs per installation and no list written
   * in advance could contain them all. What makes empty acceptable is that a
   * token with the Matrix client-API scope already drives the whole account on
   * the homeserver — reading every message, sending as the user — so accepting
   * one here grants an attacker nothing they did not already have. A deployment
   * that pins its clients statically SHOULD fill this in.
   */
  readonly allowedClientIds: readonly string[];
  /** Any one of these in the token's scope is enough. See the constant. */
  readonly acceptedScopes: readonly string[];
  /**
   * The audience the token must name, when the introspection response carries
   * one at all. MAS does not, so this is normally unset — see the module
   * comment, and {@link acceptedScopes} for what stands in its place.
   */
  readonly expectedAudience: string | undefined;
  /** The ceiling on how long an introspection answer is reused. */
  readonly cacheSeconds: number;
  readonly timeoutMs: number;
}

/** The shape of a deployment that accepts no MAS token. */
const DISABLED: MatrixAuthConfig = Object.freeze({
  enabled: false,
  issuer: "",
  introspectionUrl: "",
  clientId: "",
  clientSecret: "",
  allowedClientIds: Object.freeze([]),
  acceptedScopes: Object.freeze([...DEFAULT_ACCEPTED_SCOPES]),
  expectedAudience: undefined,
  cacheSeconds: DEFAULT_CACHE_SECONDS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
});

export function loadMatrixAuthConfig(
  environment: NodeJS.ProcessEnv = process.env,
): MatrixAuthConfig {
  const parsed = buildMatrixAuthEnvSchema().parse(environment);

  if (
    parsed.ALLO_MAS_ISSUER === undefined ||
    parsed.ALLO_MAS_INTROSPECTION_URL === undefined ||
    parsed.ALLO_MAS_INTROSPECTION_CLIENT_ID === undefined ||
    parsed.ALLO_MAS_INTROSPECTION_CLIENT_SECRET === undefined
  ) {
    /**
     * Unreachable when the issuer is set — `superRefine` above has already
     * failed the parse for each missing companion. Written out anyway because
     * it is what narrows the four values to `string` for the object below, and
     * a non-null assertion here would be an authentication boundary asserting
     * something it had not checked.
     */
    return DISABLED;
  }

  return Object.freeze({
    enabled: true,
    issuer: parsed.ALLO_MAS_ISSUER,
    introspectionUrl: parsed.ALLO_MAS_INTROSPECTION_URL,
    clientId: parsed.ALLO_MAS_INTROSPECTION_CLIENT_ID,
    clientSecret: parsed.ALLO_MAS_INTROSPECTION_CLIENT_SECRET,
    allowedClientIds: Object.freeze([...(parsed.ALLO_MAS_ALLOWED_CLIENT_IDS ?? [])]),
    acceptedScopes: Object.freeze([
      ...(parsed.ALLO_MAS_ACCEPTED_SCOPES ?? DEFAULT_ACCEPTED_SCOPES),
    ]),
    expectedAudience: parsed.ALLO_MAS_EXPECTED_AUDIENCE,
    cacheSeconds: parsed.ALLO_MAS_INTROSPECTION_CACHE_SECONDS,
    timeoutMs: parsed.ALLO_MAS_INTROSPECTION_TIMEOUT_MS,
  });
}

let cached: MatrixAuthConfig | undefined;

/**
 * The process-wide MAS configuration, parsed on first use.
 *
 * Lazy for the same reason the push and bridge ones are: importing an
 * authentication module must not crash a process whose environment has nothing
 * to do with MAS.
 */
export function matrixAuthConfig(): MatrixAuthConfig {
  if (!cached) cached = loadMatrixAuthConfig();
  return cached;
}

/** Resets the memoised config. Tests only; there is no runtime reconfiguration. */
export function resetMatrixAuthConfigForTests(): void {
  cached = undefined;
}
