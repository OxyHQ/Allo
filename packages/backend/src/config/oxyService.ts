import { canAttestWorkloadIdentity } from "@oxy.so/core/server";
import * as z from "zod";

import { logger } from "../utils/logger";

/**
 * Allo's own credential for calling the Oxy API as itself.
 *
 * ## The deployment no longer carries one
 *
 * Under oxy ADR 0026 a first-party service proves what it IS — a signed
 * `GetCallerIdentity` for the ECS task role, which Oxy replays to AWS — and gets
 * back the same short-lived service token the key pair used to buy. `@oxy.so/core`
 * falls back to that whenever no pair is configured, so the pair is now a LOCAL
 * convenience: a developer's laptop can attest nothing, and this is how it borrows
 * Allo's identity when it wants the server-to-server path.
 *
 * Which is why {@link canAuthenticateAsOxyService} exists and why nothing here
 * treats an absent pair as "unauthenticated" any more. It stopped being the same
 * question the day the task role could answer it, and a log line saying a working
 * deployment has no credential is how somebody ends up putting one back.
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
 * Whether this process can act as Allo against Oxy at all.
 *
 * Two ways, and a deployment has one of them without anybody configuring it: in
 * ECS the task role attests (oxy ADR 0026 — a signed `GetCallerIdentity` Oxy
 * replays to AWS, with no secret anywhere) and elsewhere the key pair above does.
 * A local checkout has neither, which is the honest answer to "is this on here".
 *
 * A capability, not a variable. Every caller that used to read the pair was asking
 * this and getting the right answer only while a secret was the only identity
 * there was; asked this way, removing the pair from the task definition changes
 * nothing.
 */
export function canAuthenticateAsOxyService(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    canAttestWorkloadIdentity(environment) || loadOxyServiceCredential(environment) !== undefined
  );
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
    /**
     * Three outcomes, not two, because "no pair" and "no identity" stopped being
     * the same thing. On the infrastructure the SDK attests the task role and the
     * calls that wanted a service token still get one; only the third line
     * describes a process that will genuinely call Oxy anonymously.
     */
    if (canAttestWorkloadIdentity(environment)) {
      logger.info("[Oxy] no service key pair; the SDK attests this task role instead");
    } else {
      logger.info(
        "[Oxy] no Oxy service identity: neither a key pair nor an attestable task role. " +
          "Directory lookups will call Oxy anonymously, which every one of those routes allows",
      );
    }
    return false;
  }

  client.configureServiceAuth(credential.apiKey, credential.apiSecret);
  logger.info("[Oxy] service credential configured");
  return true;
}
