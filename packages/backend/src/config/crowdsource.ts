import * as z from "zod";

/**
 * CrowdSource participatory moderation configuration (§14.6).
 *
 * A focused module rather than an addition to a general app config, because Allo
 * reads environment variables directly at their point of use and has no config
 * layer to extend. What matters is that these particular variables are validated
 * ONCE, at boot, instead of being read as `process.env.X` in four places where a
 * typo is a silent `undefined`.
 *
 * ## `CROWDSOURCE_APP_ID` is absent on purpose
 *
 * The variable names come from the packages, not from §14.6's table.
 * `@oxyhq/crowdsource` reads `CROWDSOURCE_SERVICE_KEY` — the applicationId,
 * credentialId and secret as ONE opaque value — and `CROWDSOURCE_BASE_URL`;
 * `@oxyhq/crowdsource-express` reads `CROWDSOURCE_WEBHOOK_SECRET` and
 * `CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS`.
 *
 * §14.6's `CROWDSOURCE_APP_ID` is deliberately NOT defined here. The applicationId
 * is derived from the credential, so a separate variable holding one could only
 * ever agree with the credential by luck and disagree with it by accident — and a
 * configurable applicationId is an IDOR: it is the surface through which one
 * deployment could open, read or resolve cases in another application's tenant.
 * The tenancy model exists to prevent exactly that, so the value must have no
 * inbound surface at all. There is nothing to set, which is the point.
 */

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim().length === 0 ? undefined : value;

const optionalString = (minimumLength = 1) =>
  z.preprocess(emptyAsUndefined, z.string().trim().min(minimumLength).optional());

const booleanFromEnv = (fallback: boolean) =>
  z.preprocess(
    emptyAsUndefined,
    z
      .enum(["true", "false"])
      .default(fallback ? "true" : "false")
      .transform((value) => value === "true"),
  );

const integerFromEnv = (fallback: number, minimum: number, maximum: number) =>
  z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(minimum).max(maximum).default(fallback),
  );

const httpOrigin = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  }, "must use http:// or https://")
  .refine((value) => {
    const url = new URL(value);
    return (
      /^\/*$/.test(url.pathname) &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, "must be an origin without credentials, path, query or fragment")
  .transform((value) => value.replace(/\/+$/, ""));

const crowdSourceEnvSchema = z
  .object({
    CROWDSOURCE_ENABLED: booleanFromEnv(false),
    CROWDSOURCE_SERVICE_KEY: optionalString(),
    CROWDSOURCE_BASE_URL: z.preprocess(emptyAsUndefined, httpOrigin.optional()),
    /**
     * A 16-character floor rather than merely "present": this secret is the ONLY
     * thing standing between a forged HTTP request and a moderation decision that
     * acts on Allo accounts. A short secret passes every functional test and is
     * brute-forceable, which is the combination that never gets noticed.
     */
    CROWDSOURCE_WEBHOOK_SECRET: optionalString(16),
    CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS: optionalString(16),
    CROWDSOURCE_OUTBOX_BATCH_SIZE: integerFromEnv(50, 1, 500),
    CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS: integerFromEnv(5_000, 250, 300_000),
    /**
     * `observe` is the first deployment and the default (§14.6's safe rollout):
     * decisions arrive, are verified and are recorded, and nothing is enforced
     * against any account. Allo ships in this mode.
     */
    CROWDSOURCE_ENFORCEMENT_MODE: z.preprocess(
      emptyAsUndefined,
      z.enum(["observe", "manual", "automatic"]).default("observe"),
    ),
  })
  .superRefine((environment, context) => {
    /**
     * A half-configured integration is worse than a disabled one. With a service
     * key and no webhook secret, reports leave and no decision can ever be
     * verified coming back; with a webhook secret and no service key, a receiver
     * waits for decisions about cases that were never opened. Neither gap raises
     * an error at the moment it matters — someone eventually asks why a case never
     * came back — so both directions are required together, at boot, or not at all.
     */
    if (!environment.CROWDSOURCE_ENABLED) return;

    if (!environment.CROWDSOURCE_SERVICE_KEY) {
      context.addIssue({
        code: "custom",
        path: ["CROWDSOURCE_SERVICE_KEY"],
        message: "is required when CROWDSOURCE_ENABLED=true",
      });
    }
    if (!environment.CROWDSOURCE_WEBHOOK_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["CROWDSOURCE_WEBHOOK_SECRET"],
        message:
          "is required when CROWDSOURCE_ENABLED=true — without it no decision can be verified, so reports would leave and nothing could come back",
      });
    }
  });

export interface CrowdSourceConfig {
  readonly enabled: boolean;
  readonly serviceKey?: string;
  readonly baseUrl?: string;
  readonly webhookSecret?: string;
  readonly webhookPreviousSecret?: string;
  readonly outboxBatchSize: number;
  readonly outboxPollIntervalMs: number;
  readonly enforcementMode: "observe" | "manual" | "automatic";
}

export function loadCrowdSourceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): CrowdSourceConfig {
  const parsed = crowdSourceEnvSchema.parse(environment);
  return Object.freeze({
    enabled: parsed.CROWDSOURCE_ENABLED,
    serviceKey: parsed.CROWDSOURCE_SERVICE_KEY,
    baseUrl: parsed.CROWDSOURCE_BASE_URL,
    webhookSecret: parsed.CROWDSOURCE_WEBHOOK_SECRET,
    webhookPreviousSecret: parsed.CROWDSOURCE_WEBHOOK_SECRET_PREVIOUS,
    outboxBatchSize: parsed.CROWDSOURCE_OUTBOX_BATCH_SIZE,
    outboxPollIntervalMs: parsed.CROWDSOURCE_OUTBOX_POLL_INTERVAL_MS,
    enforcementMode: parsed.CROWDSOURCE_ENFORCEMENT_MODE,
  });
}

let cached: CrowdSourceConfig | undefined;

/**
 * The process-wide configuration, parsed on first use.
 *
 * Lazy rather than module-level so that importing anything in the moderation tree
 * — a model, a provider, a type — cannot crash a process whose environment has
 * nothing to do with moderation. Validation still happens exactly once.
 */
export function crowdSourceConfig(): CrowdSourceConfig {
  if (!cached) cached = loadCrowdSourceConfig();
  return cached;
}

/** Resets the memoised config. Tests only; there is no runtime reconfiguration. */
export function resetCrowdSourceConfigForTests(): void {
  cached = undefined;
}
