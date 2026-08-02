import { createPrivateKey } from "crypto";
import * as z from "zod";

/**
 * Push notification configuration (docs/matrix/push.md).
 *
 * ## Why there is no token store any more
 *
 * On Matrix the homeserver owns the pusher registry. A client registers itself
 * with `POST /_matrix/client/v3/pushers/set`, and from then on Synapse decides
 * which events deserve a notification and posts them to a **push gateway** —
 * this backend — with the device token (`pushkey`) inside every request. Allo
 * therefore never has to know which token belongs to which user, which is why
 * `models/PushToken.ts` is gone rather than reimplemented: a second registry
 * would be one that can disagree with the homeserver's, and the way that
 * disagreement shows up is a phone that stopped ringing months ago and nobody
 * noticed.
 *
 * ## Same shape as `config/bridges.ts`, for the same reason
 *
 * Validated with zod ONCE, memoised, frozen. These variables decide whether a
 * platform can be notified at all, and a typo that reads as `undefined` at the
 * point of use is a platform that silently stops delivering — the failure mode
 * this whole change exists to end.
 *
 * ## Half a configuration is worse than none
 *
 * An app id without the credentials to deliver to it is an endpoint that accepts
 * notifications and drops them. So each platform is all-or-nothing, checked in
 * `superRefine`: a deployment that asks for iOS without an APNs key does not
 * boot. A deployment that configures neither platform is not misconfigured — it
 * is a deployment without push, and the gateway route is simply not mounted.
 */

/** Which provider carries a notification, decided by the pusher's `app_id`. */
export type PushPlatform = "android" | "ios";

export const PUSH_PLATFORMS: readonly PushPlatform[] = ["android", "ios"];

/**
 * Where the gateway router is mounted, and the route inside it.
 *
 * Two halves of one constant, composed rather than written out twice, because
 * the composed value is not a preference: Synapse parses a pusher's URL and
 * refuses any whose path is not exactly `/_matrix/push/v1/notify`, so a gateway
 * published anywhere else can never receive anything. Splitting them without
 * deriving the whole would put the mount and the published URL in two places
 * that can disagree, and the way that disagreement shows up is every pusher
 * registering successfully and never firing.
 */
export const PUSH_GATEWAY_MOUNT_PATH = "/_matrix/push";
export const PUSH_GATEWAY_NOTIFY_PATH = "/v1/notify";
export const PUSH_GATEWAY_PATH = `${PUSH_GATEWAY_MOUNT_PATH}${PUSH_GATEWAY_NOTIFY_PATH}`;

/** Apple's two front doors. Which one is reached is `ALLO_APNS_ENVIRONMENT`. */
const APNS_PRODUCTION_HOST = "https://api.push.apple.com";
const APNS_SANDBOX_HOST = "https://api.sandbox.push.apple.com";

/**
 * The shortest gateway secret this deployment will accept.
 *
 * The secret authenticates every notification Synapse sends, so it is a
 * capability over other people's phones. 32 characters of a random alphabet is
 * the same floor the bridge tokens use.
 */
const MINIMUM_SECRET_LENGTH = 32;

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === "string" && value.trim().length === 0 ? undefined : value;

const optionalString = (minimumLength = 1) =>
  z.preprocess(emptyAsUndefined, z.string().trim().min(minimumLength).optional());

/**
 * The URL clients are told to register their pusher against.
 *
 * Absolute, http(s), and with exactly {@link PUSH_GATEWAY_PATH} as its path. A
 * query string is allowed and is in fact where the capability token rides — see
 * `services/push/gatewayToken.ts` — so it is deliberately not rejected here, but
 * a URL that already carries one would produce two and Synapse would send the
 * wrong one back. Hence: no query, no fragment, no credentials.
 */
const gatewayUrl = z
  .string()
  .trim()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  }, "must use http:// or https://")
  .refine((value) => {
    const url = new URL(value);
    return url.pathname === PUSH_GATEWAY_PATH;
  }, `must have the path ${PUSH_GATEWAY_PATH} — Synapse refuses any pusher whose URL does not`)
  .refine((value) => {
    const url = new URL(value);
    return (
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, "must carry no query, fragment or credentials: the capability token is appended to it");

/**
 * A Matrix `app_id`: reverse-DNS, per platform, and stable forever.
 *
 * Stable because it is half of a pusher's identity on the homeserver. Changing
 * it does not migrate anything — it strands every pusher already registered
 * under the old one, and those keep firing at a gateway that no longer claims
 * the app id until Synapse is told they are rejected.
 */
const appId = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
    "must be a reverse-DNS application id such as so.oxy.allo.android",
  )
  .max(64, "must be at most 64 characters, which is what the Matrix specification allows");

/**
 * The gateway's shared secrets, newest first.
 *
 * A list rather than one value so a secret can be rotated without stranding
 * every pusher already registered. The first entry mints new gateway URLs;
 * every entry verifies. Dropping the previous secret is what finally retires it,
 * and it is safe once every installation has launched once — a launch
 * re-registers its pusher with a freshly minted URL.
 */
const secretList = z.preprocess(
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
    .pipe(
      z
        .array(
          z
            .string()
            .min(
              MINIMUM_SECRET_LENGTH,
              `each secret must be at least ${MINIMUM_SECRET_LENGTH} characters`,
            ),
        )
        .min(1),
    )
    .optional(),
);

const apnsEnvironment = z.preprocess(
  emptyAsUndefined,
  z.enum(["production", "sandbox"]).default("production"),
);

type PushEnvironment = Record<string, string | undefined>;

/** Whether every variable FCM needs is present. All of them or none. */
function isFcmComplete(environment: PushEnvironment): boolean {
  return (
    typeof environment.FIREBASE_PROJECT_ID === "string" &&
    environment.FIREBASE_PROJECT_ID.trim().length > 0 &&
    typeof environment.FIREBASE_SERVICE_ACCOUNT_BASE64 === "string" &&
    environment.FIREBASE_SERVICE_ACCOUNT_BASE64.trim().length > 0
  );
}

/** Whether every variable APNs needs is present. All of them or none. */
function isApnsComplete(environment: PushEnvironment): boolean {
  return (["ALLO_APNS_KEY_ID", "ALLO_APNS_TEAM_ID", "ALLO_APNS_PRIVATE_KEY_BASE64", "ALLO_APNS_TOPIC"] as const).every(
    (key) => typeof environment[key] === "string" && (environment[key] ?? "").trim().length > 0,
  );
}

function buildPushEnvSchema(raw: PushEnvironment) {
  return z
    .object({
      ALLO_PUSH_GATEWAY_URL: z.preprocess(emptyAsUndefined, gatewayUrl.optional()),
      ALLO_PUSH_GATEWAY_SECRETS: secretList,
      ALLO_PUSH_ANDROID_APP_ID: z.preprocess(emptyAsUndefined, appId.optional()),
      ALLO_PUSH_IOS_APP_ID: z.preprocess(emptyAsUndefined, appId.optional()),

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
      const androidRequested = environment.ALLO_PUSH_ANDROID_APP_ID !== undefined;
      const iosRequested = environment.ALLO_PUSH_IOS_APP_ID !== undefined;
      if (!androidRequested && !iosRequested) {
        /**
         * No platform asked for. Not an error — it is a deployment without push,
         * and the gateway is not mounted. Anything else set alongside it is
         * inert, which is preferable to refusing to boot over a variable that
         * decides nothing.
         */
        return;
      }

      if (environment.ALLO_PUSH_GATEWAY_URL === undefined) {
        context.addIssue({
          code: "custom",
          path: ["ALLO_PUSH_GATEWAY_URL"],
          message:
            "is required once a push platform is configured — it is the address clients register " +
            "their pusher against, and without it nothing can ever reach this gateway",
        });
      }

      if (environment.ALLO_PUSH_GATEWAY_SECRETS === undefined) {
        context.addIssue({
          code: "custom",
          path: ["ALLO_PUSH_GATEWAY_SECRETS"],
          message:
            "is required once a push platform is configured — without it the gateway would accept " +
            "a notification from anyone who found the URL, which is a spam relay aimed at users' phones",
        });
      }

      if (androidRequested && !isFcmComplete(raw)) {
        context.addIssue({
          code: "custom",
          path: ["FIREBASE_SERVICE_ACCOUNT_BASE64"],
          message:
            "FIREBASE_PROJECT_ID and FIREBASE_SERVICE_ACCOUNT_BASE64 are both required to enable " +
            "ALLO_PUSH_ANDROID_APP_ID: an app id without credentials is a gateway that accepts " +
            "Android notifications and drops them",
        });
      }

      if (iosRequested && !isApnsComplete(raw)) {
        context.addIssue({
          code: "custom",
          path: ["ALLO_APNS_PRIVATE_KEY_BASE64"],
          message:
            "ALLO_APNS_KEY_ID, ALLO_APNS_TEAM_ID, ALLO_APNS_PRIVATE_KEY_BASE64 and ALLO_APNS_TOPIC " +
            "are all required to enable ALLO_PUSH_IOS_APP_ID: an app id without an authentication " +
            "key is a gateway that accepts iOS notifications and drops them",
        });
      }

      if (
        androidRequested &&
        iosRequested &&
        environment.ALLO_PUSH_ANDROID_APP_ID === environment.ALLO_PUSH_IOS_APP_ID
      ) {
        context.addIssue({
          code: "custom",
          path: ["ALLO_PUSH_IOS_APP_ID"],
          message:
            "must differ from ALLO_PUSH_ANDROID_APP_ID — the app id is the only thing that says " +
            "which provider a device token belongs to, and one shared between platforms would send " +
            "Android tokens to Apple",
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
  /** Whether any platform can be delivered to. False means no gateway route. */
  readonly enabled: boolean;
  readonly gatewayUrl: string | undefined;
  /** Newest first. The first mints; all verify. See {@link secretList}. */
  readonly gatewaySecrets: readonly string[];
  /** `app_id` → platform. The only thing that decides which provider is used. */
  readonly platformByAppId: ReadonlyMap<string, PushPlatform>;
  /** Platform → `app_id`, for telling a client which one to register under. */
  readonly appIdByPlatform: ReadonlyMap<PushPlatform, string>;
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
  const parsed = buildPushEnvSchema(environment).parse(environment);

  const platformByAppId = new Map<string, PushPlatform>();
  const appIdByPlatform = new Map<PushPlatform, string>();
  if (parsed.ALLO_PUSH_ANDROID_APP_ID !== undefined) {
    platformByAppId.set(parsed.ALLO_PUSH_ANDROID_APP_ID, "android");
    appIdByPlatform.set("android", parsed.ALLO_PUSH_ANDROID_APP_ID);
  }
  if (parsed.ALLO_PUSH_IOS_APP_ID !== undefined) {
    platformByAppId.set(parsed.ALLO_PUSH_IOS_APP_ID, "ios");
    appIdByPlatform.set("ios", parsed.ALLO_PUSH_IOS_APP_ID);
  }

  const fcm =
    parsed.ALLO_PUSH_ANDROID_APP_ID !== undefined &&
    parsed.FIREBASE_PROJECT_ID !== undefined &&
    parsed.FIREBASE_SERVICE_ACCOUNT_BASE64 !== undefined
      ? Object.freeze({
          projectId: parsed.FIREBASE_PROJECT_ID,
          serviceAccountJson: Buffer.from(
            parsed.FIREBASE_SERVICE_ACCOUNT_BASE64,
            "base64",
          ).toString("utf-8"),
        })
      : undefined;

  const apns =
    parsed.ALLO_PUSH_IOS_APP_ID !== undefined &&
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
    enabled: platformByAppId.size > 0,
    gatewayUrl: parsed.ALLO_PUSH_GATEWAY_URL,
    gatewaySecrets: Object.freeze([...(parsed.ALLO_PUSH_GATEWAY_SECRETS ?? [])]),
    platformByAppId,
    appIdByPlatform,
    fcm,
    apns,
  });
}

let cached: PushConfig | undefined;

/**
 * The process-wide push configuration, parsed on first use.
 *
 * Lazy for the same reason the bridge one is: importing a push module must not
 * crash a process whose environment has nothing to do with push.
 */
export function pushConfig(): PushConfig {
  if (!cached) cached = loadPushConfig();
  return cached;
}

/** Resets the memoised config. Tests only; there is no runtime reconfiguration. */
export function resetPushConfigForTests(): void {
  cached = undefined;
}
