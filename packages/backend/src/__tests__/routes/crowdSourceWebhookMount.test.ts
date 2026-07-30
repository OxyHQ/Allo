import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The webhook signature covers the bytes that arrived, so a body parser mounted
 * ahead of this router destroys the only thing that can be verified.
 *
 * `@oxyhq/crowdsource-express` already refuses rather than re-serialising, which
 * makes the mistake loud but not LEGIBLE: what an operator sees is a signature
 * failure, which reads like a secret problem and sends the next person to rotate a
 * secret that was fine. The route's own `assertRawBody` turns that into a message
 * naming the mount order.
 *
 * These tests assemble a real Express app in both orders, because the property
 * under test is a property of the ASSEMBLY, not of a function. Asserting it any
 * other way would test a mock of the thing that breaks.
 */

vi.mock("../../services/moderation/moderationEventStore", () => ({
  mongoProcessedEventStore: () => ({
    claim: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
  }),
}));

vi.mock("../../services/moderation/ModerationInboundService", () => ({
  recordDecisionEvent: vi.fn(async () => undefined),
  recordIgnoredEvent: vi.fn(async () => undefined),
}));

import { resetCrowdSourceConfigForTests } from "../../config/crowdsource";
import { createCrowdSourceWebhookRoutes } from "../../routes/crowdSourceWebhook";

const SECRET = "a-test-webhook-secret-long-enough";

function appWith(options: { parseJsonFirst: boolean }): express.Express {
  const app = express();
  if (options.parseJsonFirst) app.use(express.json());
  app.use("/webhooks", createCrowdSourceWebhookRoutes());
  if (!options.parseJsonFirst) app.use(express.json());
  return app;
}

describe("crowdsource webhook mount order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCrowdSourceConfigForTests();
    process.env.CROWDSOURCE_WEBHOOK_SECRET = SECRET;
  });

  afterEach(() => {
    delete process.env.CROWDSOURCE_WEBHOOK_SECRET;
    delete process.env.CROWDSOURCE_ENABLED;
    resetCrowdSourceConfigForTests();
  });

  it("refuses, naming the cause, when a body parser ran first", async () => {
    const response = await request(appWith({ parseJsonFirst: true }))
      .post("/webhooks/crowdsource")
      .set("content-type", "application/json")
      .send({ id: "evt_1", type: "case.decided" });

    /**
     * 500, not 4xx: this is Allo misassembled, not a bad request. Answering
     * non-2xx also keeps the delivery on CrowdSource's retry schedule, so
     * decisions queue up rather than being lost while the deployment is broken.
     */
    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ message: "Webhook receiver is misconfigured" });
  });

  it("does not answer 500-misconfigured when mounted correctly", async () => {
    /**
     * The vacuity guard for the test above. Without it, a route that returned 500
     * unconditionally — or an app that failed to mount at all — would satisfy the
     * first assertion for entirely the wrong reason.
     *
     * An unsigned request is REJECTED here (401/400 from the SDK's verification),
     * and that is the point: it got far enough to be verified, which is exactly
     * what mounting ahead of the parser buys.
     */
    const response = await request(appWith({ parseJsonFirst: false }))
      .post("/webhooks/crowdsource")
      .set("content-type", "application/json")
      .send({ id: "evt_1", type: "case.decided" });

    expect(response.status).not.toBe(404);
    expect(response.body?.message).not.toBe("Webhook receiver is misconfigured");
    // Unsigned: refused by signature verification, never accepted.
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("is not mounted at all without a configured secret", async () => {
    /**
     * Not mounted, rather than mounted and permissive. A route that answers
     * anything without a secret is one that will eventually be reasoned about as
     * if it verified something.
     */
    delete process.env.CROWDSOURCE_WEBHOOK_SECRET;
    resetCrowdSourceConfigForTests();

    const response = await request(appWith({ parseJsonFirst: false }))
      .post("/webhooks/crowdsource")
      .send({ id: "evt_1" });

    expect(response.status).toBe(404);
  });

  it("never authenticates by Oxy session — the HMAC is the authentication", async () => {
    /**
     * An unsigned request carrying a bearer token must not be treated as
     * authorised. This is not a user endpoint, and a session must never satisfy it.
     */
    const response = await request(appWith({ parseJsonFirst: false }))
      .post("/webhooks/crowdsource")
      .set("authorization", "Bearer a-perfectly-valid-looking-token")
      .set("content-type", "application/json")
      .send({ id: "evt_1", type: "case.decided" });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
