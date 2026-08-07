import * as z from "zod";

import { logger } from "../utils/logger";

/**
 * Allo's own credential for calling the Oxy API as itself.
 *
 * ## Optional, and worth saying why
 *
 * Every lookup `services/oxy/OxyDirectoryService.ts` makes is a PUBLIC Oxy
 * route — `GET /profiles/username/:username`, `GET /users/:userId` and
 * `GET /profiles/search` carry no authentication middleware, and
 * `POST /users/by-ids` accepts an anonymous caller and answers with the same
 * public payload it gives a service. So the directory works with nothing set
 * here, and this file exists for what a credential changes rather than for what
 * it enables:
 *
 * - `getUsersByIds` takes the server-to-server path (`Authorization: Bearer
 *   <service token>`) instead of the anonymous one, which saves the
 *   `GET /csrf-token` round trip the SDK otherwise makes before every
 *   state-changing request without a bearer.
 * - Oxy attributes the traffic to Allo rather than to a datacentre IP, which is
 *   what its own rate limiting keys on.
 *
 * ## Provisioning is a human step and cannot be done from here
 *
 * A service credential is minted at `console.oxy.so` → Apps → Allo → Settings →
 * Credentials, with type `Service`, by somebody holding `owner`, `admin` or
 * `developer` on the account that owns the Allo application. The secret is
 * shown exactly once. Oxy will only mint one for a TRUSTED application
 * (`isTrustedApplication`: `isOfficial`, `isInternal`, or `type` one of
 * `first_party` / `internal` / `system`); Allo is seeded `first_party`, so this
 * should succeed, and a `403 Service credentials are only available to trusted
 * applications` means the application row is not what the seed says it is —
 * which only Oxy platform staff can put right.
 *
 * ## Both or neither
 *
 * A key without a secret is not half-configured, it is a call that throws at
 * the first lookup. Refusing to boot is the only way that shows up before a
 * user does.
 */

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim().length === 0 ? undefined : value;

/** Oxy application credential public keys are minted as `oxy_dk_<48 hex>`. */
const apiKey = z
  .string()
  .trim()
  .regex(/^oxy_dk_[0-9a-f]{8,}$/, "must be an Oxy application credential public key (oxy_dk_…)");

/** The secret is 32 random bytes as hex. A credential: never logged. */
const apiSecret = z.string().trim().min(32);

function buildOxyServiceEnvSchema() {
  return z
    .object({
      ALLO_OXY_SERVICE_API_KEY: z.preprocess(emptyAsUndefined, apiKey.optional()),
      ALLO_OXY_SERVICE_API_SECRET: z.preprocess(emptyAsUndefined, apiSecret.optional()),
    })
    .superRefine((environment, context) => {
      const hasKey = environment.ALLO_OXY_SERVICE_API_KEY !== undefined;
      const hasSecret = environment.ALLO_OXY_SERVICE_API_SECRET !== undefined;
      if (hasKey === hasSecret) return;

      context.addIssue({
        code: "custom",
        path: [hasKey ? "ALLO_OXY_SERVICE_API_SECRET" : "ALLO_OXY_SERVICE_API_KEY"],
        message:
          "ALLO_OXY_SERVICE_API_KEY and ALLO_OXY_SERVICE_API_SECRET must be set together — a key " +
          "without its secret is a service token that can never be minted, which shows up as every " +
          "bulk profile lookup returning nothing",
      });
    });
}

export interface OxyServiceCredential {
  readonly apiKey: string;
  readonly apiSecret: string;
}

export function loadOxyServiceCredential(
  environment: NodeJS.ProcessEnv = process.env,
): OxyServiceCredential | undefined {
  const parsed = buildOxyServiceEnvSchema().parse(environment);
  if (
    parsed.ALLO_OXY_SERVICE_API_KEY === undefined ||
    parsed.ALLO_OXY_SERVICE_API_SECRET === undefined
  ) {
    return undefined;
  }
  return Object.freeze({
    apiKey: parsed.ALLO_OXY_SERVICE_API_KEY,
    apiSecret: parsed.ALLO_OXY_SERVICE_API_SECRET,
  });
}

/** The one method of the Oxy SDK this module touches. */
export interface ServiceAuthConfigurable {
  configureServiceAuth(apiKey: string, apiSecret: string): void;
}

/**
 * Hands the credential to the SDK, if there is one. Returns whether it did.
 *
 * The log line names neither value — not even the public key, which identifies
 * the credential to anybody who later has to be told it was rotated.
 */
export function configureOxyServiceAuth(
  client: ServiceAuthConfigurable,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const credential = loadOxyServiceCredential(environment);
  if (credential === undefined) {
    logger.info(
      "[Oxy] no service credential configured — directory lookups will call Oxy anonymously, " +
        "which every one of those routes allows",
    );
    return false;
  }

  client.configureServiceAuth(credential.apiKey, credential.apiSecret);
  logger.info("[Oxy] service credential configured");
  return true;
}
