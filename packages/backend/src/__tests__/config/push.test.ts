import { generateKeyPairSync } from "crypto";
import { describe, expect, it } from "vitest";

import { loadPushConfig, PUSH_GATEWAY_PATH } from "../../config/push";

/**
 * `config/push.ts` — what a deployment must say before it can notify anybody.
 *
 * The rule under test throughout: half a configuration is worse than none. Every
 * one of these cases is a deployment that would otherwise boot happily and
 * produce a gateway that accepts notifications and drops them, which is
 * indistinguishable from the app being broken.
 */

const GATEWAY_URL = `https://api.allo.you${PUSH_GATEWAY_PATH}`;
const SECRET = "a-push-gateway-secret-long-enough-32ch";
const ANDROID_APP_ID = "so.oxy.allo.android";
const IOS_APP_ID = "so.oxy.allo.ios";

/** A real EC P-256 key, generated here so nothing secret is committed. */
function apnsKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  return Buffer.from(pem.toString(), "utf8").toString("base64");
}

function androidEnvironment(): NodeJS.ProcessEnv {
  return {
    ALLO_PUSH_GATEWAY_URL: GATEWAY_URL,
    ALLO_PUSH_GATEWAY_SECRETS: SECRET,
    ALLO_PUSH_ANDROID_APP_ID: ANDROID_APP_ID,
    FIREBASE_PROJECT_ID: "allo-project",
    FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from(
      JSON.stringify({ project_id: "allo-project" }),
      "utf8",
    ).toString("base64"),
  };
}

function iosEnvironment(): NodeJS.ProcessEnv {
  return {
    ALLO_PUSH_GATEWAY_URL: GATEWAY_URL,
    ALLO_PUSH_GATEWAY_SECRETS: SECRET,
    ALLO_PUSH_IOS_APP_ID: IOS_APP_ID,
    ALLO_APNS_KEY_ID: "ABCD1234EF",
    ALLO_APNS_TEAM_ID: "TEAM123456",
    ALLO_APNS_PRIVATE_KEY_BASE64: apnsKeyBase64(),
    ALLO_APNS_TOPIC: "so.oxy.allo",
  };
}

describe("a deployment with no push configured", () => {
  it("is not an error, and has no gateway", () => {
    const config = loadPushConfig({});

    expect(config.enabled).toBe(false);
    expect(config.platformByAppId.size).toBe(0);
  });

  it("stays disabled even with credentials lying around, because no app id asks for them", () => {
    const { ALLO_PUSH_ANDROID_APP_ID, ...withoutAppId } = androidEnvironment();
    expect(ALLO_PUSH_ANDROID_APP_ID).toBeDefined();

    const config = loadPushConfig(withoutAppId);

    expect(config.enabled).toBe(false);
    expect(config.fcm).toBeUndefined();
  });
});

describe("configuring Android", () => {
  it("maps the app id to FCM and keeps the decoded service account", () => {
    const config = loadPushConfig(androidEnvironment());

    expect(config.enabled).toBe(true);
    expect(config.platformByAppId.get(ANDROID_APP_ID)).toBe("android");
    expect(config.appIdByPlatform.get("android")).toBe(ANDROID_APP_ID);
    expect(config.fcm?.projectId).toBe("allo-project");
    expect(JSON.parse(config.fcm?.serviceAccountJson ?? "{}")).toEqual({
      project_id: "allo-project",
    });
  });

  it("refuses an app id with no Firebase credentials behind it", () => {
    const { FIREBASE_SERVICE_ACCOUNT_BASE64, ...halfConfigured } = androidEnvironment();
    expect(FIREBASE_SERVICE_ACCOUNT_BASE64).toBeDefined();

    expect(() => loadPushConfig(halfConfigured)).toThrow(/FIREBASE_SERVICE_ACCOUNT_BASE64/);
  });
});

describe("configuring iOS", () => {
  it("maps the app id to APNs and reads the signing key", () => {
    const config = loadPushConfig(iosEnvironment());

    expect(config.platformByAppId.get(IOS_APP_ID)).toBe("ios");
    expect(config.apns?.topic).toBe("so.oxy.allo");
    expect(config.apns?.privateKeyPem).toContain("BEGIN PRIVATE KEY");
  });

  it("reaches Apple's production host unless told otherwise", () => {
    expect(loadPushConfig(iosEnvironment()).apns?.host).toBe("https://api.push.apple.com");
    expect(
      loadPushConfig({ ...iosEnvironment(), ALLO_APNS_ENVIRONMENT: "sandbox" }).apns?.host,
    ).toBe("https://api.sandbox.push.apple.com");
  });

  it("refuses an app id with no APNs key behind it", () => {
    const { ALLO_APNS_PRIVATE_KEY_BASE64, ...halfConfigured } = iosEnvironment();
    expect(ALLO_APNS_PRIVATE_KEY_BASE64).toBeDefined();

    expect(() => loadPushConfig(halfConfigured)).toThrow(/ALLO_APNS_PRIVATE_KEY_BASE64/);
  });

  it("refuses a key that is not an elliptic-curve key, because ES256 cannot sign with it", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaKey = Buffer.from(
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      "utf8",
    ).toString("base64");

    expect(() =>
      loadPushConfig({ ...iosEnvironment(), ALLO_APNS_PRIVATE_KEY_BASE64: rsaKey }),
    ).toThrow(/ES256/);
  });

  it("refuses a key that does not decode to a PEM at all", () => {
    expect(() =>
      loadPushConfig({
        ...iosEnvironment(),
        ALLO_APNS_PRIVATE_KEY_BASE64: Buffer.from("not a key", "utf8").toString("base64"),
      }),
    ).toThrow(/ALLO_APNS_PRIVATE_KEY_BASE64/);
  });
});

describe("the gateway URL", () => {
  it("must have the path Synapse insists on, or no pusher could ever fire", () => {
    expect(() =>
      loadPushConfig({ ...androidEnvironment(), ALLO_PUSH_GATEWAY_URL: "https://api.allo.you/push" }),
    ).toThrow(/_matrix\/push\/v1\/notify/);
  });

  it("must not already carry a query, which is where the capability token goes", () => {
    expect(() =>
      loadPushConfig({
        ...androidEnvironment(),
        ALLO_PUSH_GATEWAY_URL: `${GATEWAY_URL}?t=already-here`,
      }),
    ).toThrow(/query/);
  });

  it("is required as soon as a platform is configured", () => {
    const { ALLO_PUSH_GATEWAY_URL, ...withoutUrl } = androidEnvironment();
    expect(ALLO_PUSH_GATEWAY_URL).toBeDefined();

    expect(() => loadPushConfig(withoutUrl)).toThrow(/ALLO_PUSH_GATEWAY_URL/);
  });
});

describe("the gateway secrets", () => {
  it("are required, because without one the gateway would take a notification from anyone", () => {
    const { ALLO_PUSH_GATEWAY_SECRETS, ...withoutSecret } = androidEnvironment();
    expect(ALLO_PUSH_GATEWAY_SECRETS).toBeDefined();

    expect(() => loadPushConfig(withoutSecret)).toThrow(/ALLO_PUSH_GATEWAY_SECRETS/);
  });

  it("keep their order, so the first is the one that mints", () => {
    const config = loadPushConfig({
      ...androidEnvironment(),
      ALLO_PUSH_GATEWAY_SECRETS: `${SECRET}-new, ${SECRET}-old`,
    });

    expect(config.gatewaySecrets).toEqual([`${SECRET}-new`, `${SECRET}-old`]);
  });

  it("refuse a secret short enough to guess", () => {
    expect(() =>
      loadPushConfig({ ...androidEnvironment(), ALLO_PUSH_GATEWAY_SECRETS: "short" }),
    ).toThrow(/at least 32 characters/);
  });
});

describe("the app ids", () => {
  it("cannot be shared between platforms, which would send Android tokens to Apple", () => {
    expect(() =>
      loadPushConfig({
        ...androidEnvironment(),
        ...iosEnvironment(),
        ALLO_PUSH_IOS_APP_ID: ANDROID_APP_ID,
      }),
    ).toThrow(/must differ/);
  });

  it("must be reverse-DNS, so they cannot be confused with anything else", () => {
    expect(() =>
      loadPushConfig({ ...androidEnvironment(), ALLO_PUSH_ANDROID_APP_ID: "allo" }),
    ).toThrow(/reverse-DNS/);
  });

  it("can name both platforms at once", () => {
    const config = loadPushConfig({ ...androidEnvironment(), ...iosEnvironment() });

    expect(config.platformByAppId.get(ANDROID_APP_ID)).toBe("android");
    expect(config.platformByAppId.get(IOS_APP_ID)).toBe("ios");
    expect(config.fcm).toBeDefined();
    expect(config.apns).toBeDefined();
  });
});
