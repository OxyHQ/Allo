/**
 * Conversations: creation with the initial commit in one transaction, DM
 * idempotency on `dm_key`, listing, reading, leaving.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  conversationResponseSchema,
  createConversationResponseSchema,
  errorResponseSchema,
  listConversationsResponseSchema,
  SERVER_SENDER_ID,
} from "@allo/shared-types";
import * as schema from "../../db/schema";
import { accountId, base64, createPlatformHarness, dmBetween, expectParses, mlsGroupId, TestInstance, type PlatformHarness } from "./harness";

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

describe("POST /v1/conversations", () => {
  it("creates a DM with owner, member, the creator's leaf and the initial commit + welcome, then nudges the added leaf", async () => {
    const { a, b, conversationId, created } = await dmBetween(h.app);
    const parsed = expectParses(createConversationResponseSchema, created.body);
    expect(parsed.created).toBe(true);
    expect(parsed.conversation.kind).toBe("dm");
    expect(parsed.conversation.appId).toBe("allo");
    expect(parsed.conversation.epoch).toBe(1);
    expect(parsed.conversation.lastSeq).toBe(2);
    expect(parsed.conversation.createdByAccountId).toBe(a.accountId);
    expect(parsed.conversation.myLeafState).toBe("active");
    expect(parsed.conversation.members.map((m) => [m.accountId, m.role, m.state])).toEqual([
      [a.accountId, "owner", "joined"],
      [b.accountId, "member", "joined"],
    ]);
    expect(parsed.conversation.leaves.map((l) => [l.instanceId, l.state, l.addedEpoch])).toEqual([
      [a.id, "active", 0],
      [b.id, "active", 1],
    ]);

    const events = await h.db
      .select()
      .from(schema.conversationEvents)
      .where(eq(schema.conversationEvents.conversationId, conversationId))
      .orderBy(asc(schema.conversationEvents.seq));
    expect(events.map((e) => [e.seq, e.kind, e.epoch])).toEqual([
      [1, "mls_commit", 0],
      [2, "mls_welcome", 1],
    ]);
    const deliveries = await h.db
      .select()
      .from(schema.instanceDeliveries)
      .where(eq(schema.instanceDeliveries.conversationId, conversationId));
    // The commit goes to nobody (a was alone at epoch 0); the welcome to b only.
    expect(deliveries.map((d) => [d.eventId === events[1].id ? "welcome" : "commit", d.instanceId])).toEqual([["welcome", b.id]]);
    expect(h.realtime.nudges).toEqual([{ instanceIds: [b.id], event: { conversationId } }]);
  });

  it("returns the existing DM with created:false and HTTP 200 for the same pair from either side", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const again = await b.signed("post", "/v1/conversations", {
      kind: "dm",
      mlsGroupId: mlsGroupId(),
      memberAccountIds: [a.accountId],
      idempotencyKey: "second-attempt",
    });
    expect(again.status).toBe(200);
    const parsed = expectParses(createConversationResponseSchema, again.body);
    expect(parsed.created).toBe(false);
    expect(parsed.conversation.id).toBe(conversationId);
    // From b's point of view: b's own leaf state.
    expect(parsed.conversation.myLeafState).toBe("active");
    const rows = await h.db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(rows).toHaveLength(1);
  });

  it("converges two SIMULTANEOUS creations of the same DM on one row", async () => {
    const a = await TestInstance.register(h.app, accountId("a"));
    const b = await TestInstance.register(h.app, accountId("b"));
    // Prime the pool so the burst really runs concurrently (CONVENTIONS.md).
    await Promise.all([a.signed("get", "/v1/conversations"), b.signed("get", "/v1/conversations")]);
    const body = (other: string) => ({ kind: "dm", mlsGroupId: mlsGroupId(), memberAccountIds: [other], idempotencyKey: `k-${other}` });
    const [fromA, fromB] = await Promise.all([
      a.signed("post", "/v1/conversations", body(b.accountId)),
      b.signed("post", "/v1/conversations", body(a.accountId)),
    ]);
    expect([fromA.status, fromB.status].sort()).toEqual([200, 201]);
    expect(fromA.body.conversation.id).toBe(fromB.body.conversation.id);
  });

  it("creates a group with the other members and refuses listing the creator or a self-DM", async () => {
    const a = await TestInstance.register(h.app, accountId("a"));
    const others = [accountId("m"), accountId("m")];
    const response = await a.signed("post", "/v1/conversations", {
      kind: "group",
      mlsGroupId: mlsGroupId(),
      memberAccountIds: others,
      idempotencyKey: "g1",
    });
    expect(response.status).toBe(201);
    const parsed = expectParses(createConversationResponseSchema, response.body);
    // Written in one tight loop, so their order within a millisecond is not a
    // property the schema has (AGENTS.md); the SET is what is asserted.
    expect(parsed.conversation.members.map((m) => m.accountId).sort()).toEqual([a.accountId, ...others].sort());
    expect(parsed.conversation.leaves).toHaveLength(1);

    const self = await a.signed("post", "/v1/conversations", {
      kind: "group",
      mlsGroupId: mlsGroupId(),
      memberAccountIds: [a.accountId],
      idempotencyKey: "g2",
    });
    expect(self.status).toBe(400);
    const selfDm = await a.signed("post", "/v1/conversations", {
      kind: "dm",
      mlsGroupId: mlsGroupId(),
      memberAccountIds: [a.accountId],
      idempotencyKey: "g3",
    });
    expect(selfDm.status).toBe(400);
  });

  it("treats a retried group create by the same instance as the same conversation, and another instance's reuse of the group id as a conflict", async () => {
    const a = await TestInstance.register(h.app, accountId("a"));
    const c = await TestInstance.register(h.app, accountId("c"));
    const groupId = mlsGroupId();
    const body = { kind: "group", mlsGroupId: groupId, memberAccountIds: [], idempotencyKey: "retry" };
    const first = await a.signed("post", "/v1/conversations", body);
    expect(first.status).toBe(201);
    const retry = await a.signed("post", "/v1/conversations", body);
    expect(retry.status).toBe(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.conversation.id).toBe(first.body.conversation.id);

    const reuse = await c.signed("post", "/v1/conversations", body);
    expect(reuse.status).toBe(409);
    expect(reuse.body.error.code).toBe("idempotency_conflict");
  });

  it("rolls the whole create back when the initial commit is refused", async () => {
    const a = await TestInstance.register(h.app, accountId("a"));
    const groupId = mlsGroupId();
    const response = await a.signed("post", "/v1/conversations", {
      kind: "group",
      mlsGroupId: groupId,
      memberAccountIds: [],
      idempotencyKey: "rb",
      initialCommit: {
        idempotencyKey: "rb-commit",
        kind: "mls_commit",
        epoch: 0,
        payload: base64("c"),
        commit: { newEpoch: 1, groupInfo: base64("gi-1"), addedLeaves: [{ instanceId: "does-not-exist-1", accountId: accountId("x") }], removedLeaves: [] },
      },
    });
    expect(response.status).toBe(400);
    const rows = await h.db.select().from(schema.conversations).where(eq(schema.conversations.mlsGroupId, groupId));
    expect(rows).toHaveLength(0);
  });
});

describe("GET /v1/conversations[/:id]", () => {
  it("lists only the caller's conversations and 404s a stranger", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const listA = await a.signed("get", "/v1/conversations");
    const parsedA = expectParses(listConversationsResponseSchema, listA.body);
    expect(parsedA.conversations.map((c) => c.id)).toEqual([conversationId]);

    const one = await b.signed("get", `/v1/conversations/${conversationId}`);
    expect(one.status).toBe(200);
    expect(expectParses(conversationResponseSchema, one.body).conversation.myLeafState).toBe("active");

    const stranger = await TestInstance.register(h.app, accountId("s"));
    const denied = await stranger.signed("get", `/v1/conversations/${conversationId}`);
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe("not_found");
    const list = await stranger.signed("get", "/v1/conversations");
    expect(list.body.conversations).toEqual([]);
  });
});

describe("POST /v1/conversations/:id/leave", () => {
  it("marks the member left and its leaves removed, appends member_left to the others, deletes nothing", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    await b.signed("post", `/v1/conversations/${conversationId}/leave`).expect(204);

    const view = await a.signed("get", `/v1/conversations/${conversationId}`);
    const parsed = expectParses(conversationResponseSchema, view.body);
    expect(parsed.conversation.members.find((m) => m.accountId === b.accountId)?.state).toBe("left");
    expect(parsed.conversation.leaves.find((l) => l.instanceId === b.id)?.state).toBe("removed");
    expect(parsed.conversation.lastSeq).toBe(3);

    const [control] = await h.db
      .select()
      .from(schema.conversationEvents)
      .where(eq(schema.conversationEvents.kind, "control"));
    expect(control.senderAccountId).toBe(SERVER_SENDER_ID);
    expect(control.senderInstanceId).toBeNull();
    expect(JSON.parse(Buffer.from(control.payload).toString("utf8"))).toEqual({ t: "member_left", accountId: b.accountId });
    const deliveries = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.eventId, control.id));
    expect(deliveries.map((d) => d.instanceId)).toEqual([a.id]);
    expect(h.realtime.nudges[h.realtime.nudges.length - 1]).toEqual({ instanceIds: [a.id], event: { conversationId } });

    // Gone from b's list; still readable to a. A second leave is a no-op.
    expect((await b.signed("get", "/v1/conversations")).body.conversations).toEqual([]);
    await b.signed("post", `/v1/conversations/${conversationId}/leave`).expect(204);
    expect((await a.signed("get", `/v1/conversations/${conversationId}`)).body.conversation.lastSeq).toBe(3);
  });
});

/**
 * Reviving a conversation whose MLS group lost every active leaf.
 *
 * The state is reachable in normal use — the only device in the group is
 * revoked, or the last member signs out — and it is terminal without this
 * route: nothing can be committed to a group with no live leaf, so nobody can
 * be added back, and a DM converges on its `dm_key` so there is no second
 * conversation to start instead.
 */
describe("POST /v1/conversations/:id/reset", () => {
  it("is refused while ANY device is still in the group, which is what stops it being a takeover", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const response = await b.signed("post", `/v1/conversations/${conversationId}/reset`, {
      mlsGroupId: mlsGroupId(),
      idempotencyKey: `reset-${Date.now()}-${Math.random()}`,
    });
    expect(response.status).toBe(409);
    expect(expectParses(errorResponseSchema, response.body).error.code).toBe("idempotency_conflict");
  });

  /**
   * The real shape of it: every device in the group is revoked, and one of the
   * members enrols a NEW one. That account is still a joined member and has an
   * active instance; what it does not have, and can never be given, is a leaf.
   */
  async function deadGroup() {
    const { a, b, conversationId, created } = await dmBetween(h.app);
    await a.signed("post", `/v1/instances/${a.id}/revoke`).expect(200);
    await b.signed("post", `/v1/instances/${b.id}/revoke`).expect(200);
    // b comes back on a new device: the account has no active instance, so it
    // bootstraps active — and lands in a conversation it cannot speak in.
    const b2 = await TestInstance.register(h.app, b.accountId);
    expect(b2.registration.enrollment).toBe("active");
    return { a, b, b2, conversationId, created };
  }

  it("revives it once the group is provably dead, keeping the id, the members and the dm_key", async () => {
    const { a, b, b2, conversationId } = await deadGroup();

    const dead = expectParses(conversationResponseSchema, (await b2.signed("get", `/v1/conversations/${conversationId}`)).body);
    expect(dead.conversation.leaves.every((leaf) => leaf.state !== "active")).toBe(true);
    expect(dead.conversation.myLeafState).toBeNull();
    const lastSeqBefore = dead.conversation.lastSeq;

    const group = mlsGroupId();
    const revived = await b2.signed("post", `/v1/conversations/${conversationId}/reset`, {
      mlsGroupId: group,
      idempotencyKey: `reset-${Date.now()}-${Math.random()}`,
    });
    expect(revived.status).toBe(200);
    const parsed = expectParses(conversationResponseSchema, revived.body);
    expect(parsed.conversation.id).toBe(conversationId);
    expect(parsed.conversation.mlsGroupId).toBe(group);
    expect(parsed.conversation.epoch).toBe(0);
    expect(parsed.conversation.myLeafState).toBe("active");
    // The members are untouched, so the DM is still between the same two people.
    expect(parsed.conversation.members.map((m) => m.accountId).sort()).toEqual([a.accountId, b.accountId].sort());
    // The event log is append-only: the old ciphertext stays where it is.
    expect(parsed.conversation.lastSeq).toBe(lastSeqBefore);

    // And it is idempotent: the same group posted twice resets once.
    const again = await b2.signed("post", `/v1/conversations/${conversationId}/reset`, {
      mlsGroupId: group,
      idempotencyKey: `reset-${Date.now()}-${Math.random()}`,
    });
    expect(again.status).toBe(200);
    expect(again.body.conversation.mlsGroupId).toBe(group);
  });

  it("refuses a group id another conversation owns, and a caller who is not a member", async () => {
    const { b2, conversationId } = await deadGroup();
    const other = await dmBetween(h.app);

    const stolen = await b2.signed("post", `/v1/conversations/${conversationId}/reset`, {
      mlsGroupId: other.created.body.conversation.mlsGroupId,
      idempotencyKey: `reset-${Date.now()}-${Math.random()}`,
    });
    expect(stolen.status).toBe(409);

    const stranger = await TestInstance.register(h.app, accountId("stranger-reset"));
    const refused = await stranger.signed("post", `/v1/conversations/${conversationId}/reset`, {
      mlsGroupId: mlsGroupId(),
      idempotencyKey: `reset-${Date.now()}-${Math.random()}`,
    });
    expect(refused.status).toBe(404);
  });
});
