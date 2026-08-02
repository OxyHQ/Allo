import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PUSH_GATEWAY_PATH,
  resetPushConfigForTests,
} from "../../config/push";
import pushRoutes from "../../routes/push";
import { verifyGatewayToken } from "../../services/push/gatewayToken";

/**
 * `POST /api/push/gateway` — where a device is told to send its notifications.
 *
 * Mounted here the way `server.ts` mounts it, minus the Oxy middleware: the
 * route itself performs no authentication, because in the real assembly it sits
 * inside `authenticatedApiRouter` and cannot be reached without a session. What
 * is worth testing here is the other half — that what comes back is a URL only
 * this deployment could have minted, bound to the device that asked for it.
 */

const GATEWAY_URL = `https://api.allo.you${PUSH_GATEWAY_PATH}`;
const SECRET = "a-push-gateway-secret-long-enough-32ch";
const ANDROID_APP_ID = "so.oxy.allo.android";
const PUSHKEY = "device-token-aaa";

function mintApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/push", pushRoutes);
  return app;
}

function configureAndroid(): void {
  process.env.ALLO_PUSH_GATEWAY_URL = GATEWAY_URL;
  process.env.ALLO_PUSH_GATEWAY_SECRETS = SECRET;
  process.env.ALLO_PUSH_ANDROID_APP_ID = ANDROID_APP_ID;
  process.env.FIREBASE_PROJECT_ID = "allo-project";
  process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 = Buffer.from("{}", "utf8").toString("base64");
  resetPushConfigForTests();
}

function clearConfiguration(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ALLO_PUSH_") || key.startsWith("ALLO_APNS_") || key.startsWith("FIREBASE_")) {
      delete process.env[key];
    }
  }
  resetPushConfigForTests();
}

beforeEach(clearConfiguration);
afterEach(clearConfiguration);

describe("minting a gateway URL", () => {
  it("answers with a URL the gateway will accept for that device", async () => {
    configureAndroid();

    const response = await request(mintApp())
      .post("/api/push/gateway")
      .send({ platform: "android", pushkey: PUSHKEY });

    expect(response.status).toBe(200);
    const url = new URL(response.body.data.url);
    expect(url.origin + url.pathname).toBe(GATEWAY_URL);
    expect(
      verifyGatewayToken(url.searchParams.get("t") ?? "", { appId: ANDROID_APP_ID, pushkey: PUSHKEY }, [
        SECRET,
      ]),
    ).toBe(true);
  });

  it("answers with the app id, so the client does not carry a second copy of it", async () => {
    configureAndroid();

    const response = await request(mintApp())
      .post("/api/push/gateway")
      .send({ platform: "android", pushkey: PUSHKEY });

    expect(response.body.data.appId).toBe(ANDROID_APP_ID);
  });

  it("binds the URL to the device that asked, and to no other", async () => {
    configureAndroid();

    const response = await request(mintApp())
      .post("/api/push/gateway")
      .send({ platform: "android", pushkey: PUSHKEY });

    const token = new URL(response.body.data.url).searchParams.get("t") ?? "";
    expect(
      verifyGatewayToken(token, { appId: ANDROID_APP_ID, pushkey: "another-device" }, [SECRET]),
    ).toBe(false);
  });
});

describe("a request that cannot be served", () => {
  it.each([
    ["no pushkey", { platform: "android" }],
    ["no platform", { pushkey: PUSHKEY }],
    ["a platform that is not one", { platform: "windows", pushkey: PUSHKEY }],
    ["an empty pushkey", { platform: "android", pushkey: "" }],
  ])("is refused with 400: %s", async (_description, body) => {
    configureAndroid();

    const response = await request(mintApp()).post("/api/push/gateway").send(body);

    expect(response.status).toBe(400);
  });

  it("is 404 for a platform this deployment does not deliver to", async () => {
    configureAndroid();

    const response = await request(mintApp())
      .post("/api/push/gateway")
      .send({ platform: "ios", pushkey: PUSHKEY });

    expect(response.status).toBe(404);
  });

  it("is 404 when this deployment has no push at all", async () => {
    const response = await request(mintApp())
      .post("/api/push/gateway")
      .send({ platform: "android", pushkey: PUSHKEY });

    expect(response.status).toBe(404);
  });
});
