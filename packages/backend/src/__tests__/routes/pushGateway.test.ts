import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  loadPushConfig,
  PUSH_GATEWAY_MOUNT_PATH,
  PUSH_GATEWAY_NOTIFY_PATH,
  PUSH_GATEWAY_PATH,
  type PushConfig,
  type PushPlatform,
} from "../../config/push";
import { createPushGatewayRoutes } from "../../routes/pushGateway";
import type { PushDeliveryOutcome, PushSender } from "../../services/push/delivery";
import { gatewayToken } from "../../services/push/gatewayToken";

/**
 * `POST /_matrix/push/v1/notify` — the endpoint Synapse calls and nobody else.
 *
 * Assembled the way `server.ts` assembles it: mounted with **no outer body
 * parser, no Oxy authentication and no per-user rate limiter** ahead of it. That
 * placement is part of the correctness — a homeserver has no Oxy session — so
 * the app here reproduces it rather than approximating it.
 */

const GATEWAY_URL = `https://api.allo.you${PUSH_GATEWAY_PATH}`;
const CURRENT_SECRET = "a-push-gateway-secret-long-enough-32ch";
const PREVIOUS_SECRET = "the-previous-gateway-secret-32-chars-x";
const ANDROID_APP_ID = "so.oxy.allo.android";
const IOS_APP_ID = "so.oxy.allo.ios";
const PUSHKEY = "device-token-aaa";

const NOTIFY_PATH = `${PUSH_GATEWAY_MOUNT_PATH}${PUSH_GATEWAY_NOTIFY_PATH}`;

function configWith(secrets: readonly string[]): PushConfig {
  const loaded = loadPushConfig({
    ALLO_PUSH_GATEWAY_URL: GATEWAY_URL,
    ALLO_PUSH_GATEWAY_SECRETS: secrets.join(","),
    ALLO_PUSH_ANDROID_APP_ID: ANDROID_APP_ID,
    FIREBASE_PROJECT_ID: "allo-project",
    FIREBASE_SERVICE_ACCOUNT_BASE64: Buffer.from("{}", "utf8").toString("base64"),
  });
  return loaded;
}

let outcomes: PushDeliveryOutcome[];
let sent: unknown[];

function fakeSender(): PushSender {
  return {
    platform: "android",
    send: vi.fn(async (devices) => {
      sent.push(devices);
      return devices.map((_, index) => outcomes[index] ?? { kind: "delivered" });
    }),
  };
}

function gatewayApp(config: PushConfig = configWith([CURRENT_SECRET])): express.Express {
  const senders: ReadonlyMap<PushPlatform, PushSender> = new Map([["android", fakeSender()]]);
  const app = express();
  app.use(PUSH_GATEWAY_MOUNT_PATH, createPushGatewayRoutes({ config, senders }));
  return app;
}

function notificationFor(
  devices: readonly { app_id: string; pushkey: string }[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    notification: {
      event_id: "$an-event-id",
      room_id: "!a-room:allo.you",
      counts: { unread: 2 },
      prio: "high",
      devices,
      ...overrides,
    },
  };
}

function tokenFor(pushkey: string, secret: string = CURRENT_SECRET, appId = ANDROID_APP_ID): string {
  return gatewayToken(secret, { appId, pushkey });
}

beforeEach(() => {
  outcomes = [];
  sent = [];
});

describe("a valid notification", () => {
  it("is delivered and answers with an empty rejected list", async () => {
    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY) })
      .send(notificationFor([{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }]));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rejected: [] });
    expect(sent).toHaveLength(1);
  });

  it("is delivered when its token was minted under a secret that has since been rotated", async () => {
    const response = await request(gatewayApp(configWith([CURRENT_SECRET, PREVIOUS_SECRET])))
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY, PREVIOUS_SECRET) })
      .send(notificationFor([{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }]));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rejected: [] });
  });

  it("is delivered when it carries no event, which is a counts update and not an error", async () => {
    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY) })
      .send({
        notification: {
          counts: { unread: 0 },
          devices: [{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }],
        },
      });

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
  });
});

describe("a malformed payload", () => {
  it.each([
    ["nothing", {}],
    ["no devices", { notification: { event_id: "$e" } }],
    ["an empty device list", { notification: { devices: [] } }],
    ["a device with no pushkey", { notification: { devices: [{ app_id: ANDROID_APP_ID }] } }],
  ])("is refused with 400: %s", async (_description, payload) => {
    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY) })
      .send(payload);

    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("is refused before anything is delivered, even with a valid token", async () => {
    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY) })
      .set("content-type", "application/json")
      .send("this is not json");

    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("an unauthenticated call", () => {
  it("is refused with 401 when it carries no token at all", async () => {
    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .send(notificationFor([{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }]));

    expect(response.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("is refused with 401 when the token is empty", async () => {
    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: "" })
      .send(notificationFor([{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }]));

    expect(response.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("delivers nothing when the token belongs to a different device", async () => {
    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: tokenFor("someone-elses-device") })
      .send(notificationFor([{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }]));

    // The pusher is dropped rather than retried: this deployment did not mint it,
    // and the app re-registers with a fresh URL on its next launch.
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rejected: [PUSHKEY] });
    expect(sent).toHaveLength(0);
  });

  it("delivers nothing when the token belongs to the same device under another app id", async () => {
    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY, CURRENT_SECRET, IOS_APP_ID) })
      .send(notificationFor([{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }]));

    expect(response.body).toEqual({ rejected: [PUSHKEY] });
    expect(sent).toHaveLength(0);
  });

  it("delivers nothing when the token was signed with a secret this deployment dropped", async () => {
    const response = await request(gatewayApp(configWith([CURRENT_SECRET])))
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY, PREVIOUS_SECRET) })
      .send(notificationFor([{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }]));

    expect(response.body).toEqual({ rejected: [PUSHKEY] });
    expect(sent).toHaveLength(0);
  });

  it("delivers only to the devices its token covers", async () => {
    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY) })
      .send(
        notificationFor([
          { app_id: ANDROID_APP_ID, pushkey: PUSHKEY },
          { app_id: ANDROID_APP_ID, pushkey: "another-device" },
        ]),
      );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rejected: ["another-device"] });
    expect(sent).toEqual([[expect.objectContaining({ pushkey: PUSHKEY })]]);
  });
});

describe("the rejected list", () => {
  it("names a pushkey the provider says is permanently gone", async () => {
    outcomes = [{ kind: "rejected", reason: "messaging/registration-token-not-registered" }];

    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY) })
      .send(notificationFor([{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }]));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rejected: [PUSHKEY] });
  });

  it("does not name a pushkey that only failed, and asks for a retry instead", async () => {
    outcomes = [{ kind: "failed", reason: "messaging/server-unavailable" }];

    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY) })
      .send(notificationFor([{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }]));

    // A 5xx is what puts the notification back on Synapse's retry schedule, and
    // the empty list is what keeps the pusher alive to receive it.
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ rejected: [] });
  });

  it("names a pushkey for an app id this deployment does not serve", async () => {
    const response = await request(gatewayApp())
      .post(NOTIFY_PATH)
      .query({ t: tokenFor("stray-device", CURRENT_SECRET, "com.someone.else") })
      .send(notificationFor([{ app_id: "com.someone.else", pushkey: "stray-device" }]));

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ rejected: ["stray-device"] });
  });

  it("separates the dead from the merely unlucky in one request", async () => {
    outcomes = [{ kind: "rejected", reason: "gone" }, { kind: "failed", reason: "flaky" }];
    const config = configWith([CURRENT_SECRET]);
    const senders: ReadonlyMap<PushPlatform, PushSender> = new Map([["android", fakeSender()]]);
    const app = express();
    // One token cannot cover two devices, so this case is built by giving both
    // devices the same pushkey under one token and letting the sender answer
    // twice — which is what a homeserver batching two pushers would produce.
    app.use(PUSH_GATEWAY_MOUNT_PATH, createPushGatewayRoutes({ config, senders }));

    const response = await request(app)
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY) })
      .send(
        notificationFor([
          { app_id: ANDROID_APP_ID, pushkey: PUSHKEY },
          { app_id: ANDROID_APP_ID, pushkey: PUSHKEY },
        ]),
      );

    expect(response.status).toBe(502);
    expect(response.body).toEqual({ rejected: [PUSHKEY] });
  });
});

describe("a deployment with no push configured", () => {
  it("has no gateway at all, which is indistinguishable from not having the feature", async () => {
    const app = express();
    app.use(PUSH_GATEWAY_MOUNT_PATH, createPushGatewayRoutes({ config: loadPushConfig({}) }));

    const response = await request(app)
      .post(NOTIFY_PATH)
      .query({ t: tokenFor(PUSHKEY) })
      .send(notificationFor([{ app_id: ANDROID_APP_ID, pushkey: PUSHKEY }]));

    expect(response.status).toBe(404);
  });
});
