import { createHmac } from "crypto";
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

/**
 * How the parser is configured, which turns out to decide the failure mode.
 *
 * - `none` — the webhook router is mounted first. Correct.
 * - `plain` — `express.json()` ahead of it, exactly as `server.ts` configures it
 *   today. `req.rawBody` is never set, so the SDK finds a parsed `req.body` and
 *   REFUSES. Loud.
 * - `verify-buffer` — `express.json({ verify })` ahead of it, keeping the raw
 *   bytes as a Buffer on `req.rawBody`. The SDK's `readRawBody` PREFERS that
 *   Buffer over reading the stream, so it verifies happily and the late mount
 *   SUCCEEDS. Silent. Allo does not configure this today, and nothing stops
 *   someone adding it — Alia has exactly this shape.
 */
type ParserMode = "none" | "plain" | "verify-buffer";

function appWith(mode: ParserMode): express.Express {
  const app = express();
  if (mode === "plain") {
    app.use(express.json());
  } else if (mode === "verify-buffer") {
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          Reflect.set(req, "rawBody", buf);
        },
      }),
    );
  }
  app.use("/webhooks", createCrowdSourceWebhookRoutes());
  if (mode === "none") app.use(express.json());
  return app;
}

/**
 * A correctly signed, schema-valid delivery, so a request can get all the way to
 * a handler.
 *
 * The envelope is built out in full — `createdAt`, `organizationId` and
 * `applicationId` are required by `WebhookEventEnvelopeSchema` — because a
 * payload that merely LOOKS like an event is refused at the schema step with a
 * 400, which would make the "late mount succeeds silently" test pass for the
 * wrong reason. The vacuity guard below caught exactly that.
 */
function signedDelivery(secret: string) {
  const body = {
    id: "evt_signed_1",
    type: "case.created",
    createdAt: new Date().toISOString(),
    organizationId: "org_1",
    applicationId: "app_1",
    data: { caseId: "case_1" },
  };
  const raw = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${raw}`)
    .digest("hex");
  return {
    raw,
    headers: {
      "content-type": "application/json",
      "x-crowdsource-event-id": "evt_signed_1",
      "x-crowdsource-timestamp": timestamp,
      "x-crowdsource-signature": `v1=${signature}`,
    },
  };
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
    const response = await request(appWith("plain"))
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
    const response = await request(appWith("none"))
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

    const response = await request(appWith("none"))
      .post("/webhooks/crowdsource")
      .send({ id: "evt_1" });

    expect(response.status).toBe(404);
  });

  it("refuses a late mount even when the parser kept the raw bytes", async () => {
    /**
     * The case where the SDK's own protection DISAPPEARS, and therefore the case
     * `assertRawBody` exists for.
     *
     * `readRawBody` in `@oxyhq/crowdsource-express` resolves the signed bytes in
     * order: a Buffer on `req.rawBody` FIRST, then a Buffer `req.body`, then a
     * throw if `req.body` is anything else, and only then the stream. With
     * `express.json({ verify })` the first branch hits — so a router mounted
     * AFTER the parser verifies successfully against parser-supplied bytes and
     * records the decision. No error, no log line, nothing to notice.
     *
     * Allo's `server.ts` uses a plain `express.json()` today, so it lands in the
     * throwing branch instead. That is a property of unrelated middleware, not of
     * this integration, and it can change in a commit that never mentions
     * moderation. Which is why the guard asserts `typeof req.body === 'undefined'`
     * — that proves NO PARSER RAN, and holds in both configurations — rather than
     * asserting that verification failed, which only holds in one.
     *
     * The delivery below is correctly signed, so without the guard this request
     * would be accepted.
     */
    const { raw, headers } = signedDelivery(SECRET);

    const response = await request(appWith("verify-buffer"))
      .post("/webhooks/crowdsource")
      .set(headers)
      .send(raw);

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({ message: "Webhook receiver is misconfigured" });
  });

  it("accepts that same signed delivery when mounted correctly", async () => {
    /**
     * The vacuity guard for the test above, and the one that makes it mean
     * anything: it proves the delivery really is well-formed and correctly
     * signed. Without this, a typo in the signature would make the previous test
     * pass no matter what `assertRawBody` did.
     */
    const { raw, headers } = signedDelivery(SECRET);

    const response = await request(appWith("none"))
      .post("/webhooks/crowdsource")
      .set(headers)
      .send(raw);

    expect(response.status).toBeLessThan(300);
  });

  it("never authenticates by Oxy session — the HMAC is the authentication", async () => {
    /**
     * An unsigned request carrying a bearer token must not be treated as
     * authorised. This is not a user endpoint, and a session must never satisfy it.
     */
    const response = await request(appWith("none"))
      .post("/webhooks/crowdsource")
      .set("authorization", "Bearer a-perfectly-valid-looking-token")
      .set("content-type", "application/json")
      .send({ id: "evt_1", type: "case.decided" });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
