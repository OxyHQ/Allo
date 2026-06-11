/**
 * Status (WhatsApp-style Stories) route tests.
 *
 * Exercises the HTTP + DB contract via supertest against an in-memory Mongo:
 *   - create (text / media, validation, audience normalization)
 *   - feed (contact scoping, audience rules, expiry exclusion, grouping)
 *   - view (idempotent, audience + contact enforcement, owner no-op)
 *   - viewers (owner-only)
 *   - delete (author-only)
 *
 * The realtime fan-out (`emitStatusEvent`) reads `(global as any).io`, which is
 * unset under test, so emits are safe no-ops here; the fan-out *recipient*
 * computation is covered indirectly by the audience/contact-scoping assertions.
 */

import request from "supertest";
import { buildApp } from "./testApp";
import statusRoutes from "../routes/status";
import Status, { STATUS_LIFETIME_MS } from "../models/Status";
import Conversation from "../models/Conversation";

const SELF = "self-user";
const CONTACT = "contact-user";
const OTHER_CONTACT = "other-contact-user";
const STRANGER = "stranger-user";

function appAs(userId: string) {
  return buildApp({
    injectUserId: userId,
    mount: [{ path: "/api/status", router: statusRoutes }],
  });
}

/** Make `a` and `b` contacts by giving them a shared direct conversation. */
async function makeContacts(a: string, b: string) {
  return Conversation.create({
    type: "direct",
    participants: [
      { userId: a, role: "admin", joinedAt: new Date() },
      { userId: b, role: "member", joinedAt: new Date() },
    ],
    createdBy: a,
    unreadCounts: {},
  });
}

async function createTextStatus(
  userId: string,
  overrides: Record<string, unknown> = {}
) {
  return Status.create({
    userId,
    type: "text",
    text: "hello world",
    backgroundColor: "#075E54",
    audience: { type: "all-contacts", userIds: [] },
    ...overrides,
  });
}

describe("POST /api/status", () => {
  it("rejects a request without a type", async () => {
    const res = await request(appAs(SELF)).post("/api/status").send({ text: "x" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("type");
  });

  it("rejects an unknown type", async () => {
    const res = await request(appAs(SELF))
      .post("/api/status")
      .send({ type: "gif", text: "x" });
    expect(res.status).toBe(400);
  });

  it("rejects a text status with empty text", async () => {
    const res = await request(appAs(SELF))
      .post("/api/status")
      .send({ type: "text", text: "   " });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("text");
  });

  it("rejects an image status without a mediaUrl", async () => {
    const res = await request(appAs(SELF))
      .post("/api/status")
      .send({ type: "image" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("mediaUrl");
  });

  it("creates a text status with background color and default audience", async () => {
    const res = await request(appAs(SELF))
      .post("/api/status")
      .send({ type: "text", text: "gm", backgroundColor: "#000000" });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeDefined();
    expect(res.body.data.type).toBe("text");
    expect(res.body.data.text).toBe("gm");
    expect(res.body.data.backgroundColor).toBe("#000000");
    expect(res.body.data.audience).toEqual({ type: "all-contacts", userIds: [] });
    // Sets a ~24h expiry.
    const ttl = new Date(res.body.data.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(STATUS_LIFETIME_MS - 60_000);
    expect(ttl).toBeLessThanOrEqual(STATUS_LIFETIME_MS + 1_000);
  });

  it("creates an image status with caption and strips text fields", async () => {
    const res = await request(appAs(SELF))
      .post("/api/status")
      .send({
        type: "image",
        mediaUrl: "https://cdn.example/status.jpg",
        caption: "nice",
        text: "should-be-ignored",
      });
    expect(res.status).toBe(201);
    expect(res.body.data.type).toBe("image");
    expect(res.body.data.mediaUrl).toBe("https://cdn.example/status.jpg");
    expect(res.body.data.caption).toBe("nice");
    expect(res.body.data.text).toBeUndefined();
  });

  it("normalizes an `only` audience and drops blank ids", async () => {
    const res = await request(appAs(SELF))
      .post("/api/status")
      .send({
        type: "text",
        text: "secret",
        audience: { type: "only", userIds: [CONTACT, "", CONTACT, "  "] },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.audience.type).toBe("only");
    expect(res.body.data.audience.userIds).toEqual([CONTACT]);
  });

  it("forces `all-contacts` to have an empty userIds list", async () => {
    const res = await request(appAs(SELF))
      .post("/api/status")
      .send({
        type: "text",
        text: "x",
        audience: { type: "all-contacts", userIds: [CONTACT] },
      });
    expect(res.status).toBe(201);
    expect(res.body.data.audience.userIds).toEqual([]);
  });
});

describe("GET /api/status (feed)", () => {
  it("returns the viewer's own statuses in myStatus, never in groups", async () => {
    await createTextStatus(SELF, { text: "mine" });
    const res = await request(appAs(SELF)).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.data.myStatus).toHaveLength(1);
    expect(res.body.data.myStatus[0].text).toBe("mine");
    expect(res.body.data.groups).toHaveLength(0);
  });

  it("does NOT leak a non-contact's all-contacts status (no public feed)", async () => {
    // STRANGER posts an all-contacts status but shares no conversation with SELF.
    await createTextStatus(STRANGER, { text: "stranger says hi" });
    const res = await request(appAs(SELF)).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.data.groups).toHaveLength(0);
  });

  it("shows a contact's all-contacts status grouped by author", async () => {
    await makeContacts(SELF, CONTACT);
    await createTextStatus(CONTACT, { text: "from a contact" });
    const res = await request(appAs(SELF)).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.data.groups).toHaveLength(1);
    expect(res.body.data.groups[0].userId).toBe(CONTACT);
    expect(res.body.data.groups[0].statuses).toHaveLength(1);
    expect(res.body.data.groups[0].statuses[0].text).toBe("from a contact");
    expect(res.body.data.groups[0].hasUnviewed).toBe(true);
    // Author enrichment from the mocked oxy.getUserById.
    expect(res.body.data.groups[0].author?.id).toBe(CONTACT);
  });

  it("excludes an expired status from the feed", async () => {
    await makeContacts(SELF, CONTACT);
    await createTextStatus(CONTACT, {
      text: "old",
      createdAt: new Date(Date.now() - 2 * STATUS_LIFETIME_MS),
      expiresAt: new Date(Date.now() - STATUS_LIFETIME_MS),
    });
    const res = await request(appAs(SELF)).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.data.groups).toHaveLength(0);
  });

  it("excludes an expired status from the viewer's own myStatus", async () => {
    await createTextStatus(SELF, {
      text: "old-mine",
      createdAt: new Date(Date.now() - 2 * STATUS_LIFETIME_MS),
      expiresAt: new Date(Date.now() - STATUS_LIFETIME_MS),
    });
    const res = await request(appAs(SELF)).get("/api/status");
    expect(res.body.data.myStatus).toHaveLength(0);
  });

  it("hides a contact's `only` status when the viewer is not in the allowlist", async () => {
    await makeContacts(SELF, CONTACT);
    await createTextStatus(CONTACT, {
      text: "private",
      audience: { type: "only", userIds: [OTHER_CONTACT] },
    });
    const res = await request(appAs(SELF)).get("/api/status");
    expect(res.body.data.groups).toHaveLength(0);
  });

  it("shows a contact's `only` status when the viewer IS in the allowlist", async () => {
    await makeContacts(SELF, CONTACT);
    await createTextStatus(CONTACT, {
      text: "for you",
      audience: { type: "only", userIds: [SELF] },
    });
    const res = await request(appAs(SELF)).get("/api/status");
    expect(res.body.data.groups).toHaveLength(1);
    expect(res.body.data.groups[0].statuses[0].text).toBe("for you");
  });

  it("hides a contact's `except` status when the viewer is excluded", async () => {
    await makeContacts(SELF, CONTACT);
    await createTextStatus(CONTACT, {
      text: "not for you",
      audience: { type: "except", userIds: [SELF] },
    });
    const res = await request(appAs(SELF)).get("/api/status");
    expect(res.body.data.groups).toHaveLength(0);
  });

  it("groups multiple statuses from the same author chronologically", async () => {
    await makeContacts(SELF, CONTACT);
    const t1 = new Date(Date.now() - 60_000);
    const t2 = new Date(Date.now() - 30_000);
    await createTextStatus(CONTACT, { text: "first", createdAt: t1 });
    await createTextStatus(CONTACT, { text: "second", createdAt: t2 });
    const res = await request(appAs(SELF)).get("/api/status");
    expect(res.body.data.groups).toHaveLength(1);
    const texts = res.body.data.groups[0].statuses.map((s: { text: string }) => s.text);
    expect(texts).toEqual(["first", "second"]);
  });
});

describe("POST /api/status/:id/view", () => {
  it("404s for a missing status", async () => {
    const res = await request(appAs(SELF)).post(
      "/api/status/64b000000000000000000000/view"
    );
    expect(res.status).toBe(404);
  });

  it("is a no-op success when the owner views their own status", async () => {
    const status = await createTextStatus(SELF);
    const res = await request(appAs(SELF)).post(`/api/status/${status._id}/view`);
    expect(res.status).toBe(200);
    const fresh = await Status.findById(status._id).lean();
    expect(fresh?.viewers).toHaveLength(0);
  });

  it("records a contact's view and is idempotent", async () => {
    await makeContacts(SELF, CONTACT);
    const status = await createTextStatus(CONTACT);

    const first = await request(appAs(SELF)).post(`/api/status/${status._id}/view`);
    expect(first.status).toBe(200);
    expect(first.body.data.viewedByMe).toBe(true);

    const second = await request(appAs(SELF)).post(`/api/status/${status._id}/view`);
    expect(second.status).toBe(200);

    const fresh = await Status.findById(status._id).lean();
    expect(fresh?.viewers).toHaveLength(1);
    expect(fresh?.viewers[0].userId).toBe(SELF);
  });

  it("forbids a non-contact from viewing an all-contacts status", async () => {
    // No shared conversation between SELF and CONTACT.
    const status = await createTextStatus(CONTACT);
    const res = await request(appAs(SELF)).post(`/api/status/${status._id}/view`);
    expect(res.status).toBe(403);
    const fresh = await Status.findById(status._id).lean();
    expect(fresh?.viewers).toHaveLength(0);
  });

  it("forbids a contact excluded by an `only` audience", async () => {
    await makeContacts(SELF, CONTACT);
    const status = await createTextStatus(CONTACT, {
      audience: { type: "only", userIds: [OTHER_CONTACT] },
    });
    const res = await request(appAs(SELF)).post(`/api/status/${status._id}/view`);
    expect(res.status).toBe(403);
  });

  it("records exactly one viewer entry under two concurrent views (race-safe)", async () => {
    await makeContacts(SELF, CONTACT);
    const status = await createTextStatus(CONTACT);
    const app = appAs(SELF);

    // Fire both views simultaneously; the atomic conditional $push must let only
    // one of them insert the viewer (no duplicate entries, no duplicate emits).
    const [a, b] = await Promise.all([
      request(app).post(`/api/status/${status._id}/view`),
      request(app).post(`/api/status/${status._id}/view`),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);

    const fresh = await Status.findById(status._id).lean();
    expect(fresh?.viewers).toHaveLength(1);
    expect(fresh?.viewers[0].userId).toBe(SELF);
  });
});

describe("GET /api/status/:id/viewers", () => {
  it("returns viewers for the author", async () => {
    await makeContacts(SELF, CONTACT);
    const status = await createTextStatus(SELF);
    await request(appAs(CONTACT)).post(`/api/status/${status._id}/view`);

    const res = await request(appAs(SELF)).get(`/api/status/${status._id}/viewers`);
    expect(res.status).toBe(200);
    expect(res.body.data.viewers).toHaveLength(1);
    expect(res.body.data.viewers[0].userId).toBe(CONTACT);
    expect(res.body.data.viewers[0].user?.id).toBe(CONTACT);
  });

  it("forbids a non-author from reading viewers", async () => {
    const status = await createTextStatus(CONTACT);
    const res = await request(appAs(SELF)).get(`/api/status/${status._id}/viewers`);
    expect(res.status).toBe(403);
  });
});

describe("DELETE /api/status/:id", () => {
  it("lets the author delete their status", async () => {
    const status = await createTextStatus(SELF);
    const res = await request(appAs(SELF)).delete(`/api/status/${status._id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);
    const fresh = await Status.findById(status._id).lean();
    expect(fresh).toBeNull();
  });

  it("forbids a non-author from deleting a status", async () => {
    const status = await createTextStatus(CONTACT);
    const res = await request(appAs(SELF)).delete(`/api/status/${status._id}`);
    expect(res.status).toBe(403);
    const fresh = await Status.findById(status._id).lean();
    expect(fresh).not.toBeNull();
  });

  it("404s when deleting a missing status", async () => {
    const res = await request(appAs(SELF)).delete(
      "/api/status/64b000000000000000000000"
    );
    expect(res.status).toBe(404);
  });
});
