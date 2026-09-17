import { generateKeyPairSync } from "crypto";
import { describe, expect, it } from "vitest";

import { loadPushConfig } from "../../config/push";

/**
 * `config/push.ts` — what a deployment must say before it can notify anybody.
 *
 * The rule under test throughout: half a configuration is worse than none. Every
 * one of these cases is a deployment that would otherwise boot happily and
 * produce a platform that looks enabled and delivers nothing, which is
 * indistinguishable from the app being broken.
 */

/** A real EC P-256 key, generated here so nothing secret is committed. */
function apnsKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  return Buffer.from(pem.toString(), "utf8").toString("base64");
}

function androidEnvironment(): NodeJS.ProcessEnv {
  return {
    FIREBASE_PROJECT_ID: "allo-project",
    FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from(
      JSON.stringify({ project_id: "allo-project" }),
      "utf8",
    ).toString("base64"),
  };
}

function iosEnvironment(): NodeJS.ProcessEnv {
  return {
    ALLO_APNS_KEY_ID: "ABCD1234EF",
    ALLO_APNS_TEAM_ID: "TEAM123456",
    ALLO_APNS_PRIVATE_KEY_BASE64: apnsKeyBase64(),
    ALLO_APNS_TOPIC: "so.oxy.allo",
  };
}

describe("a deployment with no push configured", () => {
  it("is not an error, and has no senders", () => {
    const config = loadPushConfig({});

    expect(config.enabled).toBe(false);
    expect(config.fcm).toBeUndefined();
    expect(config.apns).toBeUndefined();
  });

  it("treats an empty variable as unset", () => {
    const config = loadPushConfig({ FIREBASE_PROJECT_ID: "  ", ALLO_APNS_TOPIC: "" });

    expect(config.enabled).toBe(false);
  });
});

describe("configuring Android", () => {
  it("enables FCM and keeps the decoded service account", () => {
    const config = loadPushConfig(androidEnvironment());

    expect(config.enabled).toBe(true);
    expect(config.fcm?.projectId).toBe("allo-project");
    expect(JSON.parse(config.fcm?.serviceAccountJson ?? "{}")).toEqual({
      project_id: "allo-project",
    });
    expect(config.apns).toBeUndefined();
  });

  it("refuses a project id with no service account behind it", () => {
    const { FIREBASE_SERVICE_ACCOUNT_BASE64, ...halfConfigured } = androidEnvironment();
    expect(FIREBASE_SERVICE_ACCOUNT_BASE64).toBeDefined();

    expect(() => loadPushConfig(halfConfigured)).toThrow(/FIREBASE_SERVICE_ACCOUNT_BASE64/);
  });

  it("refuses a service account with no project id", () => {
    const { FIREBASE_PROJECT_ID, ...halfConfigured } = androidEnvironment();
    expect(FIREBASE_PROJECT_ID).toBeDefined();

    expect(() => loadPushConfig(halfConfigured)).toThrow(/FIREBASE_PROJECT_ID/);
  });
});

describe("configuring iOS", () => {
  it("enables APNs and reads the signing key", () => {
    const config = loadPushConfig(iosEnvironment());

    expect(config.enabled).toBe(true);
    expect(config.apns?.topic).toBe("so.oxy.allo");
    expect(config.apns?.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(config.fcm).toBeUndefined();
  });

  it("reaches Apple's production host unless told otherwise", () => {
    expect(loadPushConfig(iosEnvironment()).apns?.host).toBe("https://api.push.apple.com");
    expect(
      loadPushConfig({ ...iosEnvironment(), ALLO_APNS_ENVIRONMENT: "sandbox" }).apns?.host,
    ).toBe("https://api.sandbox.push.apple.com");
  });

  it("refuses a key id with no key behind it", () => {
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

describe("both platforms", () => {
  it("can be configured at once", () => {
    const config = loadPushConfig({ ...androidEnvironment(), ...iosEnvironment() });

    expect(config.enabled).toBe(true);
    expect(config.fcm).toBeDefined();
    expect(config.apns).toBeDefined();
  });

  it("refuses to boot when either half is incomplete, even if the other is whole", () => {
    const { ALLO_APNS_TOPIC, ...iosWithoutTopic } = iosEnvironment();
    expect(ALLO_APNS_TOPIC).toBeDefined();

    expect(() => loadPushConfig({ ...androidEnvironment(), ...iosWithoutTopic })).toThrow(
      /ALLO_APNS_TOPIC/,
    );
  });
});
