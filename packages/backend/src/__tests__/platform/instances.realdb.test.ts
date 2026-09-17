/**
 * Enrollment and the instance signature, end to end against a real database
 * with real Ed25519 keys. Every response is parsed with its contract schema.
 */

import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  INSTANCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  MAX_CLOCK_SKEW_MS,
  errorResponseSchema,
  instanceResponseSchema,
  listAccountInstancesResponseSchema,
  listInstancesResponseSchema,
  listPendingEnrollmentsResponseSchema,
  registerInstanceResponseSchema,
} from "@allo/shared-types";
import * as schema from "../../db/schema";
import {
  accountId,
  createPlatformHarness,
  expectParses,
  generateEd25519,
  signMessage,
  TestInstance,
  USER_HEADER,
  type PlatformHarness,
} from "./harness";

let h: PlatformHarness;

beforeAll(async () => {
  h = await createPlatformHarness();
}, 180_000);

afterAll(async () => {
  await h?.drop();
});

beforeEach(() => {
  h.realtime.reset();
});

describe("POST /v1/instances", () => {
  it("bootstraps: the first instance on an account is active with no challenge", async () => {
    const me = await TestInstance.register(h.app, accountId());
    expect(me.registration.enrollment).toBe("active");
    expect(me.registration.challenge).toBeUndefined();
    expect(me.registration.instance.status).toBe("active");
    expect(me.registration.instance.enrolledAt).not.toBeNull();
    expect(me.registration.instance.approvedByInstanceId).toBeNull();
    // Nullable fields are present as null, never absent.
    expect(Object.keys(me.registration.instance)).toEqual(
      expect.arrayContaining(["revokedAt", "lastSeenAt", "approvedByInstanceId", "approvalSignature"]),
    );
  });

  it("a second instance is pending with a base64url challenge", async () => {
    const account = accountId();
    await TestInstance.register(h.app, account);
    const second = await TestInstance.register(h.app, account, { platform: "ios" });
    expect(second.registration.enrollment).toBe("pending");
    expect(second.registration.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.registration.instance.status).toBe("pending");
    expect(second.registration.instance.enrolledAt).toBeNull();
  });

  it("refuses a malformed body with validation_failed and the issues", async () => {
    const response = await request(h.app)
      .post("/v1/instances")
      .set(USER_HEADER, accountId())
      .send({ appId: "allo", platform: "toaster", displayName: "", signingPublicKey: "short" });
    expect(response.status).toBe(400);
    const body = expectParses(errorResponseSchema, response.body);
    expect(body.error.code).toBe("validation_failed");
    expect(Array.isArray(body.error.details)).toBe(true);
  });

  it("requires an Oxy session", async () => {
    const response = await request(h.app).post("/v1/instances").send({});
    expect(response.status).toBe(401);
  });

  it("refuses the same signing key twice on one account", async () => {
    const account = accountId();
    const key = generateEd25519();
    await TestInstance.register(h.app, account, { key });
    const response = await request(h.app)
      .post("/v1/instances")
      .set(USER_HEADER, account)
      .send({ appId: "allo", platform: "web", displayName: "dup", signingPublicKey: key.publicKeyBase64 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("idempotency_conflict");
  });
});

describe("GET /v1/instances and /v1/accounts/:accountId/instances", () => {
  it("lists own instances in full and another account's active ones projected, without the push token", async () => {
    const account = accountId();
    const first = await TestInstance.register(h.app, account);
    const second = await TestInstance.register(h.app, account);
    await first.signed("put", "/v1/instances/me/push", { provider: "fcm", token: "secret-token" }).expect(204);

    const own = await request(h.app).get("/v1/instances").set(USER_HEADER, account);
    const ownParsed = expectParses(listInstancesResponseSchema, own.body);
    expect(ownParsed.instances.map((i) => i.id)).toEqual([first.id, second.id]);
    expect(JSON.stringify(own.body)).not.toContain("secret-token");

    const other = await request(h.app).get(`/v1/accounts/${account}/instances`).set(USER_HEADER, accountId("stranger"));
    const otherParsed = expectParses(listAccountInstancesResponseSchema, other.body);
    // Active only: the pending second instance is not somebody another account can address.
    expect(otherParsed.instances.map((i) => i.id)).toEqual([first.id]);
    expect(Object.keys(otherParsed.instances[0]).sort()).toEqual(
      ["accountId", "appId", "approvalSignature", "approvedByInstanceId", "id", "platform", "signingPublicKey", "status"].sort(),
    );
    expect(JSON.stringify(other.body)).not.toContain("secret-token");
    expect(JSON.stringify(other.body)).not.toContain("displayName");
  });

  it("404s an account Allo has never seen", async () => {
    const response = await request(h.app).get(`/v1/accounts/${accountId("nobody")}/instances`).set(USER_HEADER, accountId());
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
  });
});

describe("approval", () => {
  it("an active instance approves a pending one with a signature over the enrollment message", async () => {
    const account = accountId();
    const first = await TestInstance.register(h.app, account);
    const second = await TestInstance.register(h.app, account);

    const pending = await first.signed("get", "/v1/instances/pending");
    const pendingParsed = expectParses(listPendingEnrollmentsResponseSchema, pending.body);
    expect(pendingParsed.pending.map((p) => p.instance.id)).toEqual([second.id]);
    expect(pendingParsed.pending[0].challenge).toBe(second.registration.challenge);

    const approvalSignature = first.approvalSignatureFor(second);
    const response = await first.signed("post", `/v1/instances/${second.id}/approve`, { approvalSignature });
    expect(response.status).toBe(200);
    const parsed = expectParses(instanceResponseSchema, response.body);
    expect(parsed.instance.status).toBe("active");
    expect(parsed.instance.approvedByInstanceId).toBe(first.id);
    expect(parsed.instance.approvalSignature).toBe(approvalSignature);
    expect(parsed.instance.enrolledAt).not.toBeNull();
    expect(h.realtime.approved).toEqual([second.id]);

    // The challenge is cleared: it is gone from the pending list and the row.
    const after = await first.signed("get", "/v1/instances/pending");
    expect(after.body.pending).toEqual([]);
    const [row] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, second.id));
    expect(row.enrollmentChallenge).toBeNull();

    // And the newly active instance can now sign requests itself.
    await second.signed("get", "/v1/instances/pending").expect(200);
  });

  it("refuses an approval signed over the wrong challenge, by the wrong key, or by another account", async () => {
    const account = accountId();
    const first = await TestInstance.register(h.app, account);
    const second = await TestInstance.register(h.app, account);

    const wrongMessage = signMessage(first.key, "allo-enroll-v1\nsomething else");
    const bad = await first.signed("post", `/v1/instances/${second.id}/approve`, { approvalSignature: wrongMessage });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe("unauthorized");

    const stranger = await TestInstance.register(h.app, accountId("stranger"));
    const foreign = await stranger.signed("post", `/v1/instances/${second.id}/approve`, {
      approvalSignature: stranger.approvalSignatureFor(second),
    });
    expect(foreign.status).toBe(404);

    // A pending instance cannot approve anything: it cannot even sign a request.
    const third = await TestInstance.register(h.app, account);
    const fromPending = await third.signed("post", `/v1/instances/${second.id}/approve`, {
      approvalSignature: third.approvalSignatureFor(second),
    });
    expect(fromPending.status).toBe(403);
    expect(fromPending.body.error.code).toBe("instance_not_active");

    // Nothing was activated along the way.
    const [row] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, second.id));
    expect(row.status).toBe("pending");
    expect(h.realtime.approved).toEqual([]);
  });

  it("rejects a pending instance, after which it is revoked and cannot sign", async () => {
    const account = accountId();
    const first = await TestInstance.register(h.app, account);
    const second = await TestInstance.register(h.app, account);
    const response = await first.signed("post", `/v1/instances/${second.id}/reject`);
    expect(response.status).toBe(200);
    expect(expectParses(instanceResponseSchema, response.body).instance.status).toBe("revoked");
    const later = await second.signed("get", "/v1/instances/pending");
    expect(later.status).toBe(403);
    expect(later.body.error.code).toBe("instance_revoked");
  });
});

describe("the request signature", () => {
  it("accepts a valid signature and answers 401 unauthorized when the body was tampered with", async () => {
    const me = await TestInstance.register(h.app, accountId());
    await me.signed("put", "/v1/instances/me/push", { provider: "apns", token: "t" }).expect(204);

    const headers = me.headers("PUT", "/v1/instances/me/push", JSON.stringify({ provider: "apns", token: "t" }));
    const tampered = await request(h.app)
      .put("/v1/instances/me/push")
      .set(headers)
      .set("content-type", "application/json")
      .send(JSON.stringify({ provider: "apns", token: "u" }));
    expect(tampered.status).toBe(401);
    expect(tampered.body.error.code).toBe("unauthorized");
  });

  it("covers the query string: the same path with a different query does not verify", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const headers = me.headers("GET", "/v1/sync?limit=5");
    const response = await request(h.app).get("/v1/sync?limit=6").set(headers);
    expect(response.status).toBe(401);
    await request(h.app).get("/v1/sync?limit=5").set(headers).expect(200);
  });

  it("rejects a stale timestamp, a future one, and a missing header", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const stale = await me.signed("get", "/v1/sync", undefined, { timestampMs: Date.now() - MAX_CLOCK_SKEW_MS - 1_000 });
    expect(stale.status).toBe(401);
    const future = await me.signed("get", "/v1/sync", undefined, { timestampMs: Date.now() + MAX_CLOCK_SKEW_MS + 1_000 });
    expect(future.status).toBe(401);
    const edge = await me.signed("get", "/v1/sync", undefined, { timestampMs: Date.now() - MAX_CLOCK_SKEW_MS + 5_000 });
    expect(edge.status).toBe(200);

    const headers = me.headers("GET", "/v1/sync");
    delete headers[SIGNATURE_HEADER];
    const missing = await request(h.app).get("/v1/sync").set(headers);
    expect(missing.status).toBe(401);
  });

  it("refuses an instance owned by another account with 403 forbidden", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const headers = me.headers("GET", "/v1/sync");
    headers[USER_HEADER] = accountId("other");
    const response = await request(h.app).get("/v1/sync").set(headers);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("forbidden");
  });

  it("refuses an unknown instance id and a revoked one with their own codes", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const unknown = me.headers("GET", "/v1/sync");
    unknown[INSTANCE_HEADER] = "no-such-instance-id";
    const missing = await request(h.app).get("/v1/sync").set(unknown);
    expect(missing.status).toBe(401);

    await me.signed("post", `/v1/instances/${me.id}/revoke`).expect(200);
    const revoked = await me.signed("get", "/v1/sync");
    expect(revoked.status).toBe(403);
    expect(revoked.body.error.code).toBe("instance_revoked");
  });

  it("verifies against the STORED key: a signature by another valid key is refused", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const impostor = generateEd25519();
    const headers = me.headers("GET", "/v1/sync");
    const timestamp = headers[TIMESTAMP_HEADER];
    const { signedRequestMessage } = await import("@allo/shared-types");
    const { EMPTY_BODY_SHA256_HEX } = await import("@allo/shared-types");
    headers[SIGNATURE_HEADER] = signMessage(
      impostor,
      signedRequestMessage({ method: "GET", pathWithQuery: "/v1/sync", timestampMs: Number(timestamp), bodySha256Hex: EMPTY_BODY_SHA256_HEX }),
    );
    const response = await request(h.app).get("/v1/sync").set(headers);
    expect(response.status).toBe(401);
  });
});

describe("revocation", () => {
  it("revokes, disconnects, and tells the account; the instance cannot sign afterwards", async () => {
    const account = accountId();
    const first = await TestInstance.register(h.app, account);
    const second = await TestInstance.register(h.app, account);
    await first.approve(second);

    const response = await first.signed("post", `/v1/instances/${second.id}/revoke`);
    expect(response.status).toBe(200);
    const parsed = expectParses(instanceResponseSchema, response.body);
    expect(parsed.instance.status).toBe("revoked");
    expect(parsed.instance.revokedAt).not.toBeNull();
    expect(h.realtime.revoked).toEqual([{ accountId: account, instanceId: second.id }]);
    expect(h.realtime.disconnected).toEqual([second.id]);

    const after = await second.signed("get", "/v1/instances/pending");
    expect(after.body.error.code).toBe("instance_revoked");

    // Revoking again is a no-op answer, not an error.
    await first.signed("post", `/v1/instances/${second.id}/revoke`).expect(200);
  });

  it("registration parses with the contract schema in both outcomes", async () => {
    const account = accountId();
    const a = await request(h.app)
      .post("/v1/instances")
      .set(USER_HEADER, account)
      .send({ appId: "allo", platform: "web", displayName: "one", signingPublicKey: generateEd25519().publicKeyBase64 });
    expectParses(registerInstanceResponseSchema, a.body);
    const b = await request(h.app)
      .post("/v1/instances")
      .set(USER_HEADER, account)
      .send({ appId: "allo", platform: "web", displayName: "two", signingPublicKey: generateEd25519().publicKeyBase64 });
    expectParses(registerInstanceResponseSchema, b.body);
  });
});

describe("push token", () => {
  it("stores and clears the token, and the pair CHECK refuses half a registration", async () => {
    const me = await TestInstance.register(h.app, accountId());
    await me.signed("put", "/v1/instances/me/push", { provider: "fcm", token: "abc" }).expect(204);
    let [row] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, me.id));
    expect(row.pushProvider).toBe("fcm");
    expect(row.pushToken).toBe("abc");
    await me.signed("delete", "/v1/instances/me/push").expect(204);
    [row] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, me.id));
    expect(row.pushToken).toBeNull();
    expect(row.pushProvider).toBeNull();

    const bad = await me.signed("put", "/v1/instances/me/push", { provider: "sms", token: "abc" });
    expect(bad.status).toBe(400);
  });
});
