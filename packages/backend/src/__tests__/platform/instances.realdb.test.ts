/**
 * Enrollment and the instance signature, end to end against a real database
 * with real Ed25519 keys. Every response is parsed with its contract schema.
 */

import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  INSTANCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  MAX_CLOCK_SKEW_MS,
  enrollmentApprovalMessage,
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
  generateX25519,
  mlsGroupId,
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
    expect(me.registration.instance.enrollmentChallenge).toBeNull();
    // Nullable fields are present as null, never absent.
    expect(Object.keys(me.registration.instance)).toEqual(
      expect.arrayContaining(["revokedAt", "lastSeenAt", "approvedByInstanceId", "approvalSignature", "enrollmentChallenge"]),
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
    // While pending the challenge travels only in `challenge`, not on the instance.
    expect(second.registration.instance.enrollmentChallenge).toBeNull();
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
      .send({
        appId: "allo",
        platform: "web",
        displayName: "dup",
        signingPublicKey: key.publicKeyBase64,
        transferPublicKey: generateX25519().publicKeyBase64,
      });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("idempotency_conflict");
  });
});

describe("the transfer key", () => {
  it("is stored at registration and serialised on both the own and the public projection", async () => {
    const account = accountId();
    const me = await TestInstance.register(h.app, account);
    expect(me.registration.instance.transferPublicKey).toBe(me.transferKey.publicKeyBase64);
    const other = await request(h.app).get(`/v1/accounts/${account}/instances`).set(USER_HEADER, accountId("stranger"));
    const parsed = expectParses(listAccountInstancesResponseSchema, other.body);
    expect(parsed.instances[0].transferPublicKey).toBe(me.transferKey.publicKeyBase64);
  });

  it("is required at registration", async () => {
    const response = await request(h.app)
      .post("/v1/instances")
      .set(USER_HEADER, accountId())
      .send({ appId: "allo", platform: "web", displayName: "old client", signingPublicKey: generateEd25519().publicKeyBase64 });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_failed");
  });

  it("PUT /v1/instances/me/transfer-key sets it on a row that has none (a Phase 2 instance) and answers with the instance", async () => {
    const me = await TestInstance.register(h.app, accountId());
    await h.db.update(schema.clientInstances).set({ transferPublicKey: null }).where(eq(schema.clientInstances.id, me.id));
    let own = expectParses(listInstancesResponseSchema, (await request(h.app).get("/v1/instances").set(USER_HEADER, me.accountId)).body);
    expect(own.instances[0].transferPublicKey).toBeNull();

    const fresh = generateX25519();
    const response = await me.signed("put", "/v1/instances/me/transfer-key", { transferPublicKey: fresh.publicKeyBase64 });
    expect(response.status).toBe(200);
    expect(expectParses(instanceResponseSchema, response.body).instance.transferPublicKey).toBe(fresh.publicKeyBase64);
    own = expectParses(listInstancesResponseSchema, (await request(h.app).get("/v1/instances").set(USER_HEADER, me.accountId)).body);
    expect(own.instances[0].transferPublicKey).toBe(fresh.publicKeyBase64);

    const malformed = await me.signed("put", "/v1/instances/me/transfer-key", { transferPublicKey: "not-a-key" });
    expect(malformed.status).toBe(400);
    const unsigned = await request(h.app).put("/v1/instances/me/transfer-key").set(USER_HEADER, me.accountId).send({ transferPublicKey: fresh.publicKeyBase64 });
    expect(unsigned.status).toBe(401);
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
    // Never a pending one: it is not somebody another account can address.
    expect(otherParsed.instances.map((i) => i.id)).toEqual([first.id]);
    expect(Object.keys(otherParsed.instances[0]).sort()).toEqual(
      ["accountId", "appId", "approvalSignature", "approvedByInstanceId", "enrollmentChallenge", "id", "platform", "signingPublicKey", "status", "transferPublicKey"].sort(),
    );
    expect(JSON.stringify(other.body)).not.toContain("secret-token");
    expect(JSON.stringify(other.body)).not.toContain("displayName");
  });

  it("publishes the challenge to other accounts only once the instance is approved", async () => {
    const account = accountId();
    const first = await TestInstance.register(h.app, account);
    const second = await TestInstance.register(h.app, account);
    const stranger = accountId("stranger");

    // Pending: the challenge is a secret between the server and the owner. It
    // must not appear in another account's view — nor, defensively, in the
    // owner's own listing; only the pending list and the registration carry it.
    let own = await request(h.app).get("/v1/instances").set(USER_HEADER, account);
    const pendingView = expectParses(listInstancesResponseSchema, own.body).instances.find((i) => i.id === second.id);
    expect(pendingView?.status).toBe("pending");
    expect(pendingView?.enrollmentChallenge).toBeNull();
    expect(JSON.stringify(own.body)).not.toContain(second.registration.challenge as string);
    const publicBefore = await request(h.app).get(`/v1/accounts/${account}/instances`).set(USER_HEADER, stranger);
    expect(JSON.stringify(publicBefore.body)).not.toContain(second.registration.challenge as string);

    await first.approve(second);

    const publicAfter = await request(h.app).get(`/v1/accounts/${account}/instances`).set(USER_HEADER, stranger);
    const parsed = expectParses(listAccountInstancesResponseSchema, publicAfter.body);
    const bootstrap = parsed.instances.find((i) => i.id === first.id);
    const approved = parsed.instances.find((i) => i.id === second.id);
    expect(bootstrap?.enrollmentChallenge).toBeNull();
    expect(approved?.enrollmentChallenge).toBe(second.registration.challenge);
    expect(approved?.approvalSignature).not.toBeNull();
    own = await request(h.app).get("/v1/instances").set(USER_HEADER, account);
    expect(expectParses(listInstancesResponseSchema, own.body).instances.find((i) => i.id === second.id)?.enrollmentChallenge).toBe(second.registration.challenge);
  });

  it("keeps a revoked approver in the public listing, with its status, so what it approved still chains", async () => {
    const account = accountId();
    const first = await TestInstance.register(h.app, account);
    const second = await TestInstance.register(h.app, account);
    await first.approve(second);
    const third = await TestInstance.register(h.app, account); // pending, never listed
    await second.signed("post", `/v1/instances/${first.id}/revoke`).expect(200);

    const response = await request(h.app).get(`/v1/accounts/${account}/instances`).set(USER_HEADER, accountId("stranger"));
    const parsed = expectParses(listAccountInstancesResponseSchema, response.body);
    expect(parsed.instances.map((i) => [i.id, i.status])).toEqual([
      [first.id, "revoked"],
      [second.id, "active"],
    ]);
    expect(parsed.instances.map((i) => i.id)).not.toContain(third.id);
    // The revoked approver still carries the key the chain is verified with.
    expect(parsed.instances[0].signingPublicKey).toBe(first.key.publicKeyBase64);
    expect(parsed.instances[1].approvedByInstanceId).toBe(first.id);
    expect(parsed.instances[1].enrollmentChallenge).toBe(second.registration.challenge);
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

    // Off the pending list; the challenge is KEPT and now published, because the
    // approval signature is over it and a verifier needs both.
    const after = await first.signed("get", "/v1/instances/pending");
    expect(after.body.pending).toEqual([]);
    const [row] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, second.id));
    expect(row.enrollmentChallenge).toBe(second.registration.challenge);
    expect(parsed.instance.enrollmentChallenge).toBe(second.registration.challenge);
    expect(enrollmentApprovalMessage({
      accountId: account,
      newInstanceId: parsed.instance.id,
      newSigningPublicKey: parsed.instance.signingPublicKey,
      challenge: parsed.instance.enrollmentChallenge as string,
    })).toBe(enrollmentApprovalMessage({ accountId: account, newInstanceId: second.id, newSigningPublicKey: second.key.publicKeyBase64, challenge: second.registration.challenge as string }));

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
      .send({
        appId: "allo",
        platform: "web",
        displayName: "one",
        signingPublicKey: generateEd25519().publicKeyBase64,
        transferPublicKey: generateX25519().publicKeyBase64,
      });
    expectParses(registerInstanceResponseSchema, a.body);
    const b = await request(h.app)
      .post("/v1/instances")
      .set(USER_HEADER, account)
      .send({
        appId: "allo",
        platform: "web",
        displayName: "two",
        signingPublicKey: generateEd25519().publicKeyBase64,
        transferPublicKey: generateX25519().publicKeyBase64,
      });
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

describe("a member whose first instance arrives after the conversation", () => {
  /** Alice's DM with `bob`, created with no initial commit: Bob is `joined` with no leaf. */
  async function dmAwaiting(bob: string) {
    const alice = await TestInstance.register(h.app, accountId("a"));
    const created = await alice.signed("post", "/v1/conversations", {
      kind: "dm",
      mlsGroupId: mlsGroupId(),
      memberAccountIds: [bob],
      idempotencyKey: `await-${bob}`,
    });
    expect(created.status).toBe(201);
    return { alice, conversationId: created.body.conversation.id as string };
  }

  async function insertActiveLeaf(conversationId: string, instance: TestInstance): Promise<void> {
    await h.db.insert(schema.conversationLeaves).values({
      id: randomUUID(),
      conversationId,
      instanceId: instance.id,
      accountId: instance.accountId,
      state: "active",
      addedEpoch: 1,
    });
  }

  it("bootstrap registration nudges the conversation's active leaves, and not the new instance", async () => {
    const bob = accountId("b");
    const { alice, conversationId } = await dmAwaiting(bob);
    h.realtime.reset();

    const bobDevice = await TestInstance.register(h.app, bob);
    expect(bobDevice.registration.enrollment).toBe("active");
    expect(h.realtime.nudges).toEqual([{ instanceIds: [alice.id], event: { conversationId } }]);
    expect(h.realtime.nudges[0].instanceIds).not.toContain(bobDevice.id);
  });

  it("approval nudges too when the account still holds no leaf, and stays silent once it does", async () => {
    // Bob's first device exists BEFORE Alice creates the DM, so it is the approval that matters.
    const first = await TestInstance.register(h.app, accountId("b"));
    const { alice, conversationId } = await dmAwaiting(first.accountId);
    const second = await TestInstance.register(h.app, first.accountId);
    h.realtime.reset();

    await first.approve(second);
    expect(h.realtime.nudges).toEqual([{ instanceIds: [alice.id], event: { conversationId } }]);

    // Alice's elector has since added Bob's first device: a third device approved later is that device's business.
    await insertActiveLeaf(conversationId, first);
    const third = await TestInstance.register(h.app, first.accountId);
    h.realtime.reset();
    await first.approve(third);
    expect(h.realtime.approved).toEqual([third.id]);
    expect(h.realtime.nudges).toEqual([]);
  });

  it("an account with no conversation awaiting it triggers nothing", async () => {
    // Alice already added Bob's first device; his second one changes nothing for her.
    const bob = accountId("b");
    const { conversationId } = await dmAwaiting(bob);
    const bobDevice = await TestInstance.register(h.app, bob);
    await insertActiveLeaf(conversationId, bobDevice);
    h.realtime.reset();

    const stranger = await TestInstance.register(h.app, accountId("s"));
    expect(stranger.registration.enrollment).toBe("active");
    const bobSecond = await TestInstance.register(h.app, bob);
    await bobDevice.approve(bobSecond);
    expect(h.realtime.nudges).toEqual([]);
  });
});
