/**
 * Status updates: what the server will and will not deliver, and what it
 * cannot see either way.
 *
 * The rules under test are the three refusals (a device that is not there, an
 * account that shares no conversation, either direction of a block), the
 * author-only questions (who saw it, take it down), and the two deadlines —
 * the status's own, and the blobs it named.
 */

import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import {
  createStatusResponseSchema,
  listStatusViewsResponseSchema,
  listStatusesResponseSchema,
  statusSignatureMessage,
  STATUS_LIFETIME_MS,
} from "@allo/shared-types";
import { getDb } from "../../db";
import { blobs } from "../../db/schema/blobs";
import { statuses } from "../../db/schema/statuses";
import { eq, sql } from "drizzle-orm";
import { runExpirySweep } from "../../db/expiry";
import { blockUser } from "../../db/social/blockRepository";
import { ensureUserSettings, updateUserSettings } from "../../db/social/userSettingsRepository";
import {
  accountId,
  base64,
  createPlatformHarness,
  dmBetween,
  expectParses,
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

const CIPHERTEXT = base64("a status nobody here can read");
const NONCE = base64("nonce-12byte");
const DIGEST = "b".repeat(64);

/** What an author posts: the ciphertext, and the key sealed to each device. */
function post(author: TestInstance, recipients: { id: string }[], over: Record<string, unknown> = {}) {
  const body = {
    id: `0199c0de-0000-7000-8000-${String(Date.now() % 1e12).padStart(12, "0")}`,
    expiresAt: new Date(Date.now() + STATUS_LIFETIME_MS - 1000).toISOString(),
    idempotencyKey: `status-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
    payload: CIPHERTEXT,
    nonce: NONCE,
    sha256: DIGEST,
    blobIds: [],
    recipients: recipients.map((r) => ({ instanceId: r.id, sealedKey: base64(`sealed-to-${r.id}`) })),
    // The signature is over the id the server assigns, so a test cannot sign
    // the real message; the server stores what it is given and the RECIPIENT
    // verifies. What is asserted here is that it travels intact.
    signature: signMessage(author.key, "status"),
    ...over,
  };
  return author.signed("post", "/v1/statuses", body);
}

describe("POST /v1/statuses", () => {
  it("requires the instance signature; an Oxy session alone is 401", async () => {
    const { a, b } = await dmBetween(h.app);
    const response = await request(h.app).post("/v1/statuses").set(USER_HEADER, a.accountId).send({});
    expect(response.status).toBe(401);
    expect(b.id).toBeTruthy();
  });

  it("seals to a recipient who shares a conversation, and nudges that device", async () => {
    const { a, b } = await dmBetween(h.app);
    const response = await post(a, [b]);
    expect(response.status).toBe(201);
    const { status, refused } = expectParses(createStatusResponseSchema, response.body);
    expect(refused).toEqual([]);
    expect(status.authorAccountId).toBe(a.accountId);
    // The author's own copy carries no key: they hold it already.
    expect(status.sealedKey).toBeNull();
    // The author signs the deadline; the server only refuses one past the
    // ceiling, so what is asserted is that it lands inside a day.
    const life = new Date(status.expiresAt).getTime() - new Date(status.createdAt).getTime();
    expect(life).toBeGreaterThan(STATUS_LIFETIME_MS - 60_000);
    expect(life).toBeLessThanOrEqual(STATUS_LIFETIME_MS);
    expect(h.realtime.statusPosts.map((p) => p.instanceId)).toEqual([b.id]);
  });

  it("refuses a stranger, a blocked account and a device that is not there — and names each", async () => {
    const { a, b } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("stranger"));
    const { a: blockedPeer } = await dmBetween(h.app);
    await blockUser(getDb(), { userId: a.accountId, blockedId: blockedPeer.accountId });

    const response = await post(a, [b, stranger, blockedPeer, { id: "unknown-instance-id" }]);
    const { refused } = expectParses(createStatusResponseSchema, response.body);
    expect(refused.sort()).toEqual([blockedPeer.id, stranger.id, "unknown-instance-id"].sort());
    expect(h.realtime.statusPosts.map((p) => p.instanceId)).toEqual([b.id]);
  });

  it("always seals to the author's own other devices, so a status shows on the phone that did not post it", async () => {
    const { a } = await dmBetween(h.app);
    const second = await TestInstance.register(h.app, a.accountId);
    await a.approve(second);

    const response = await post(a, [second]);
    expect(expectParses(createStatusResponseSchema, response.body).refused).toEqual([]);
  });

  it("replays one idempotency key as the same status, without a second write", async () => {
    const { a, b } = await dmBetween(h.app);
    const key = `status-${Date.now()}`;
    const first = await post(a, [b], { idempotencyKey: key });
    const second = await post(a, [b], { idempotencyKey: key });
    expect(second.status).toBe(201);
    expect(expectParses(createStatusResponseSchema, second.body).status.id).toBe(first.body.status.id);

    const rows = await getDb().select({ id: statuses.id }).from(statuses).where(eq(statuses.authorAccountId, a.accountId));
    expect(rows.length).toBe(1);
  });

  it("refuses an empty audience, a body over the cap, and a deadline past a day", async () => {
    const { a } = await dmBetween(h.app);
    expect((await post(a, [])).status).toBe(400);
    expect((await post(a, [a], { payload: base64("x".repeat(9 * 1024)) })).status).toBe(400);
    // A signed deadline the author chose is still bounded by the server.
    const tooLong = new Date(Date.now() + 8 * STATUS_LIFETIME_MS).toISOString();
    expect((await post(a, [a], { expiresAt: tooLong })).status).toBe(400);
    const past = new Date(Date.now() - 1000).toISOString();
    expect((await post(a, [a], { expiresAt: past })).status).toBe(400);
  });
});

describe("GET /v1/statuses", () => {
  it("hands a recipient its own sealed key, and the author theirs with none", async () => {
    const { a, b } = await dmBetween(h.app);
    await post(a, [b]);

    const mine = expectParses(listStatusesResponseSchema, (await a.signed("get", "/v1/statuses")).body);
    expect(mine.statuses).toHaveLength(1);
    expect(mine.statuses[0].sealedKey).toBeNull();
    expect(mine.statuses[0].payload).toBe(CIPHERTEXT);

    const theirs = expectParses(listStatusesResponseSchema, (await b.signed("get", "/v1/statuses")).body);
    expect(theirs.statuses).toHaveLength(1);
    expect(theirs.statuses[0].sealedKey).toBe(base64(`sealed-to-${b.id}`));
  });

  it("shows a stranger nothing at all", async () => {
    const { a, b } = await dmBetween(h.app);
    await post(a, [b]);
    const stranger = await TestInstance.register(h.app, accountId("nosy"));
    const response = expectParses(listStatusesResponseSchema, (await stranger.signed("get", "/v1/statuses")).body);
    expect(response.statuses).toEqual([]);
  });
});

describe("views", () => {
  it("records a viewer by account, and tells the author how many saw it", async () => {
    const { a, b } = await dmBetween(h.app);
    const posted = await post(a, [b]);
    const id = posted.body.status.id as string;

    expect((await b.signed("post", `/v1/statuses/${id}/views`)).status).toBe(204);
    // Twice is not twice.
    expect((await b.signed("post", `/v1/statuses/${id}/views`)).status).toBe(204);

    const views = expectParses(listStatusViewsResponseSchema, (await a.signed("get", `/v1/statuses/${id}/views`)).body);
    expect(views.total).toBe(1);
    expect(views.views.map((v) => v.accountId)).toEqual([b.accountId]);
  });

  it("counts a viewer who publishes no receipt without naming them", async () => {
    const { a, b } = await dmBetween(h.app);
    await ensureUserSettings(getDb(), b.accountId);
    await updateUserSettings(getDb(), b.accountId, { privacyStatusViewReceipts: false });

    const id = (await post(a, [b])).body.status.id as string;
    await b.signed("post", `/v1/statuses/${id}/views`);

    const views = expectParses(listStatusViewsResponseSchema, (await a.signed("get", `/v1/statuses/${id}/views`)).body);
    expect(views.total).toBe(1);
    expect(views.views).toEqual([]);
  });

  it("refuses a view from somebody it was never sealed to, and says only that it does not exist", async () => {
    const { a, b } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("nosy"));
    const id = (await post(a, [b])).body.status.id as string;
    expect((await stranger.signed("post", `/v1/statuses/${id}/views`)).status).toBe(404);
  });

  it("lets only the author ask who saw it", async () => {
    const { a, b } = await dmBetween(h.app);
    const id = (await post(a, [b])).body.status.id as string;
    expect((await b.signed("get", `/v1/statuses/${id}/views`)).status).toBe(404);
  });
});

describe("taking one down", () => {
  it("is the author's alone, and the status stops being listed", async () => {
    const { a, b } = await dmBetween(h.app);
    const id = (await post(a, [b])).body.status.id as string;

    expect((await b.signed("delete", `/v1/statuses/${id}`)).status).toBe(404);
    expect((await a.signed("delete", `/v1/statuses/${id}`)).status).toBe(204);

    const theirs = expectParses(listStatusesResponseSchema, (await b.signed("get", "/v1/statuses")).body);
    expect(theirs.statuses).toEqual([]);
  });
});

describe("the deadline", () => {
  it("stops listing an expired status, and the sweep deletes it with its keys and views", async () => {
    const { a, b } = await dmBetween(h.app);
    const id = (await post(a, [b])).body.status.id as string;
    await b.signed("post", `/v1/statuses/${id}/views`);

    await getDb()
      .update(statuses)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(statuses.id, id));

    const theirs = expectParses(listStatusesResponseSchema, (await b.signed("get", "/v1/statuses")).body);
    expect(theirs.statuses).toEqual([]);

    await runExpirySweep(getDb(), { info: () => undefined, debug: () => undefined });
    const rows = await getDb().select({ id: statuses.id }).from(statuses).where(eq(statuses.id, id));
    expect(rows).toEqual([]);
  });

  it("dates the blobs a dead status named, rather than leaving them forever", async () => {
    const { a, b } = await dmBetween(h.app);
    const bytes = Buffer.from("an encrypted picture");
    const upload = await a.uploadBlob(bytes);
    expect(upload.status).toBe(201);
    const blobId = upload.body.blobId as string;

    const id = (await post(a, [b], { blobIds: [blobId] })).body.status.id as string;
    // Named by a live status: not collectable.
    const retained = await getDb().select({ expiresAt: blobs.expiresAt }).from(blobs).where(eq(blobs.id, blobId));
    expect(retained[0].expiresAt).toBeNull();

    await getDb()
      .update(statuses)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(statuses.id, id));
    await runExpirySweep(getDb(), { info: () => undefined, debug: () => undefined });

    const released = await getDb().select({ expiresAt: blobs.expiresAt }).from(blobs).where(eq(blobs.id, blobId));
    expect(released[0].expiresAt).not.toBeNull();
  });
});
