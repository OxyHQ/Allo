import { createPrivateKey } from "crypto";
import * as z from "zod";

/**
 * Push notification configuration: the provider credentials, and nothing else.
 *
 * Which device gets notified, and with what, is the delivery worker's business
 * (`docs/platform/api-v1.md`); this module only decides whether a platform CAN
 * be delivered to. It holds no token registry — a device's push token lives on
 * its `client_instances` row, next to the instance it belongs to.
 *
 * ## Validated once, memoised, frozen
 *
 * These variables decide whether a platform can be notified at all, and a typo
 * that reads as `undefined` at the point of use is a platform that silently
 * stops delivering — the failure mode this module exists to end.
 *
 * ## Half a configuration is worse than none
 *
 * A platform is enabled by its credentials being COMPLETE, and each platform is
 * all-or-nothing, checked in `superRefine`: a deployment that sets a Firebase
 * project id without a service account, or an APNs key id without the key, does
 * not boot. A deployment that configures neither platform is not misconfigured —
 * it is a deployment without push, and `enabled` is false.
 */

/** Which provider carries a notification. */
export type PushPlatform = "android" | "ios";

export const PUSH_PLATFORMS: readonly PushPlatform[] = ["android", "ios"];

/** Apple's two front doors. Which one is reached is `ALLO_APNS_ENVIRONMENT`. */
const APNS_PRODUCTION_HOST = "https://api.push.apple.com";
const APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com";

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim().length === 0 ? undefined : value;

const optionalString = (minimumLength = 1) =>
  z.preprocess(emptyAsUndefined, z.string().trim().min(minimumLength).optional());

const apnsEnvironment = z.preprocess(
  emptyAsUndefined,
  z.enum(["production", "sandbox"]).default("production"),
);

const FCM_VARIABLES = ["FIREBASE_PROJECT_ID", "FIREBASE_SERVICE_ACCOUNT_BASE64"] as const;
const APNS_VARIABLES = [
  "ALLO_APNS_KEY_ID",
  "ALLO_APNS_TEAM_ID",
  "ALLO_APNS_PRIVATE_KEY_BASE64",
  "ALLO_APNS_TOPIC",
] as const;

type ParsedPushEnvironment = Record<string, string | undefined>;

/** Which of a platform's variables are set. All of them or none is the rule. */
function presentAmong(
  environment: ParsedPushEnvironment,
  variables: readonly string[],
): readonly string[] {
  return variables.filter((key) => environment[key] !== undefined);
}

function buildPushEnvSchema() {
  return z
    .object({
      FIREBASE_PROJECT_ID: optionalString(),
      FIREBASE_SERVICE_ACCOUNT_BASE64: optionalString(),

      ALLO_APNS_KEY_ID: optionalString(),
      ALLO_APNS_TEAM_ID: optionalString(),
      ALLO_APNS_PRIVATE_KEY_BASE64: optionalString(),
      /** The app's bundle identifier. APNs calls it the topic. */
      ALLO_APNS_TOPIC: optionalString(),
      ALLO_APNS_ENVIRONMENT: apnsEnvironment,
    })
    .superRefine((environment, context) => {
      const fcmPresent = presentAmong(environment, FCM_VARIABLES);
      if (fcmPresent.length > 0 && fcmPresent.length < FCM_VARIABLES.length) {
        const missing = FCM_VARIABLES.filter((key) => !fcmPresent.includes(key));
        context.addIssue({
          code: "custom",
          path: [missing[0] ?? FCM_VARIABLES[0]],
          message:
            `${FCM_VARIABLES.join(" and ")} are both required to enable Android push; ` +
            `${missing.join(", ")} is missing. Half a configuration is a platform that ` +
            "looks enabled and delivers nothing",
        });
      }

      const apnsPresent = presentAmong(environment, APNS_VARIABLES);
      if (apnsPresent.length > 0 && apnsPresent.length < APNS_VARIABLES.length) {
        const missing = APNS_VARIABLES.filter((key) => !apnsPresent.includes(key));
        context.addIssue({
          code: "custom",
          path: [missing[0] ?? APNS_VARIABLES[0]],
          message:
            `${APNS_VARIABLES.join(", ")} are all required to enable iOS push; ` +
            `${missing.join(", ")} is missing. Half a configuration is a platform that ` +
            "looks enabled and delivers nothing",
        });
      }
    });
}

export interface FcmCredentials {
  readonly projectId: string;
  /**
   * The service account, decoded from base64.
   *
   * A credential: never logged, never returned by an endpoint. Kept as the JSON
   * text rather than a parsed object because that is what `firebase-admin`'s
   * `cert()` is handed, and parsing it twice is two places for the shape to be
   * wrong.
   */
  readonly serviceAccountJson: string;
}

export interface ApnsCredentials {
  readonly keyId: string;
  readonly teamId: string;
  /** The `.p8` file's contents, PEM, decoded from base64. A credential. */
  readonly privateKeyPem: string;
  /** The app's bundle identifier. */
  readonly topic: string;
  readonly host: string;
}

export interface PushConfig {
  /** Whether any platform can be delivered to. */
  readonly enabled: boolean;
  readonly fcm: FcmCredentials | undefined;
  readonly apns: ApnsCredentials | undefined;
}

/**
 * Decodes and checks the APNs signing key at boot.
 *
 * Apple's key is an EC P-256 private key in a PKCS#8 PEM. Checking it here means
 * a mistyped or truncated key is a boot failure with a message naming the
 * variable, rather than a signing error on the first notification of the day —
 * which arrives as "iOS users get nothing" and looks like a client bug.
 */
function readApnsPrivateKey(base64Key: string): string {
  let pem: string;
  try {
    pem = Buffer.from(base64Key, "base64").toString("utf-8");
  } catch (error) {
    throw new Error(
      `ALLO_APNS_PRIVATE_KEY_BASE64 is not valid base64: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let asymmetricKeyType: string | undefined;
  try {
    asymmetricKeyType = createPrivateKey(pem).asymmetricKeyType;
  } catch (error) {
    throw new Error(
      "ALLO_APNS_PRIVATE_KEY_BASE64 does not decode to a private key PEM. It must be the base64 of " +
        `the whole .p8 file downloaded from Apple: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (asymmetricKeyType !== "ec") {
    throw new Error(
      `ALLO_APNS_PRIVATE_KEY_BASE64 decodes to a ${asymmetricKeyType ?? "unknown"} key, but APNs ` +
        "tokens are signed with ES256 and need the elliptic-curve key from the .p8 file",
    );
  }

  return pem;
}

export function loadPushConfig(environment: NodeJS.ProcessEnv = process.env): PushConfig {
  const parsed = buildPushEnvSchema().parse(environment);

  const fcm =
    parsed.FIREBASE_PROJECT_ID !== undefined && parsed.FIREBASE_SERVICE_ACCOUNT_BASE64 !== undefined
      ? Object.freeze({
          projectId: parsed.FIREBASE_PROJECT_ID,
          serviceAccountJson: Buffer.from(
            parsed.FIREBASE_SERVICE_ACCOUNT_BASE64,
            "base64",
          ).toString("utf-8"),
        })
      : undefined;

  const apns =
    parsed.ALLO_APNS_KEY_ID !== undefined &&
    parsed.ALLO_APNS_TEAM_ID !== undefined &&
    parsed.ALLO_APNS_PRIVATE_KEY_BASE64 !== undefined &&
    parsed.ALLO_APNS_TOPIC !== undefined
      ? Object.freeze({
          keyId: parsed.ALLO_APNS_KEY_ID,
          teamId: parsed.ALLO_APNS_TEAM_ID,
          privateKeyPem: readApnsPrivateKey(parsed.ALLO_APNS_PRIVATE_KEY_BASE64),
          topic: parsed.ALLO_APNS_TOPIC,
          host:
            parsed.ALLO_APNS_ENVIRONMENT === "sandbox"
              ? APNS_SANDBOX_HOST
              : APNS_PRODUCTION_HOST,
        })
      : undefined;

  return Object.freeze({
    enabled: fcm !== undefined || apns !== undefined,
    fcm,
    apns,
  });
}

let cached: PushConfig | undefined;

/**
 * The process-wide push configuration, parsed on first use.
 *
 * Lazy so that importing a push module cannot crash a process whose
 * environment has nothing to do with push.
 */
export function pushConfig(): PushConfig {
  if (!cached) cached = loadPushConfig();
  return cached;
}

/** Resets the memoised config. Tests only; there is no runtime reconfiguration. */
export function resetPushConfigForTests(): void {
  cached = undefined;
}
