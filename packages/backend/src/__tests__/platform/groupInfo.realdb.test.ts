/**
 * Self-join by MLS external commit (`docs/platform/crypto.md`, external join)
 * and the stored GroupInfo it works from.
 *
 * The rules under test are `appendClientEvent`'s for `CommitInfo.kind`
 * (`db/platform/eventRepository.ts`) and `groupInfoService.ts`: who may post
 * an external or resync commit, that such a commit adds EXACTLY the sender,
 * what the leaf and member rows look like afterwards, who gets the delivery,
 * and that every accepted commit leaves the GroupInfo of its new epoch
 * behind. The mutation cases at the end each fail one predicate at a time so
 * that removing a check from the server fails a named test rather than
 * weakening a passing one.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import {
  epochConflictDetailsSchema,
  errorResponseSchema,
  groupInfoResponseSchema,
  submitEventResponseSchema,
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

let keyCounter = 0;
const key = () => `gi-${process.pid}-${++keyCounter}`;

async function recipientsOf(eventId: string): Promise<string[]> {
  const rows = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.eventId, eventId));
  return rows.map((row) => row.instanceId).sort();
}

async function conversationRow(conversationId: string) {
  const [row] = await h.db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  return row;
}

async function leafRow(conversationId: string, instanceId: string) {
  const [row] = await h.db
    .select()
    .from(schema.conversationLeaves)
    .where(and(eq(schema.conversationLeaves.conversationId, conversationId), eq(schema.conversationLeaves.instanceId, instanceId)));
  return row ?? null;
}

async function groupInfoRow(conversationId: string) {
  const [row] = await h.db.select().from(schema.conversationGroupInfo).where(eq(schema.conversationGroupInfo.conversationId, conversationId));
  return row ?? null;
}

async function eventKinds(conversationId: string): Promise<string[]> {
  const rows = await h.db
    .select({ kind: schema.conversationEvents.kind })
    .from(schema.conversationEvents)
    .where(eq(schema.conversationEvents.conversationId, conversationId))
    .orderBy(asc(schema.conversationEvents.seq));
  return rows.map((row) => row.kind);
}

/** A DM a↔b at epoch 1 plus b's second device, approved and stocked, holding NO leaf. */
async function dmWithLeaflessSecondDevice() {
  const dm = await dmBetween(h.app);
  const b2 = await TestInstance.register(h.app, dm.b.accountId, { platform: "ios" });
  await dm.b.approve(b2);
  await b2.stockKeyPackages(2);
  return { ...dm, b2 };
}

function externalCommit(self: TestInstance, epoch: number, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key(),
    kind: "mls_commit",
    epoch,
    payload: base64(`external-${epoch}`),
    commit: {
      kind: "external",
      newEpoch: epoch + 1,
      addedLeaves: [{ instanceId: self.id, accountId: self.accountId }],
      removedLeaves: [],
      groupInfo: base64(`gi-external-${epoch + 1}`),
      ...overrides,
    },
  };
}

function resyncCommit(self: TestInstance, epoch: number, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key(),
    kind: "mls_commit",
    epoch,
    payload: base64(`resync-${epoch}`),
    commit: {
      kind: "resync",
      newEpoch: epoch + 1,
      addedLeaves: [{ instanceId: self.id, accountId: self.accountId }],
      removedLeaves: [self.id],
      groupInfo: base64(`gi-resync-${epoch + 1}`),
      ...overrides,
    },
  };
}

describe("external commit (kind: external)", () => {
  it("a member's leafless device joins itself: leaf active at the new epoch, no welcome, delivered to every other active leaf, GroupInfo replaced", async () => {
    const { a, b, b2, conversationId } = await dmWithLeaflessSecondDevice();
    expect(await leafRow(conversationId, b2.id)).toBeNull();
    const before = await groupInfoRow(conversationId);
    expect(before).toMatchObject({ epoch: 1, signerInstanceId: a.id });
    h.realtime.reset();

    const response = await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1));
    expect(response.status).toBe(200);
    const parsed = expectParses(submitEventResponseSchema, response.body);
    expect(parsed.event.seq).toBe(3);

    // The commit went to the two leaves active at epoch 1 and not to the joiner, which authored it.
    expect(await recipientsOf(parsed.event.id)).toEqual([a.id, b.id].sort());
    expect(h.realtime.nudges).toEqual([{ instanceIds: expect.arrayContaining([a.id, b.id]), event: { conversationId } }]);
    expect(h.realtime.nudges[0].instanceIds).toHaveLength(2);
    // No `mls_welcome` followed it: the joiner holds the new state already.
    expect(await eventKinds(conversationId)).toEqual(["mls_commit", "mls_welcome", "mls_commit"]);

    const conversation = await conversationRow(conversationId);
    expect(conversation.currentEpoch).toBe(2);
    expect(conversation.lastSeq).toBe(3);
    expect(await leafRow(conversationId, b2.id)).toMatchObject({ state: "active", addedEpoch: 2, removedEpoch: null, accountId: b.accountId });
    const view = await b2.signed("get", `/v1/conversations/${conversationId}`);
    expect(view.body.conversation.myLeafState).toBe("active");
    expect(view.body.conversation.members.find((m: { accountId: string }) => m.accountId === b.accountId).state).toBe("joined");

    // The joiner's commit carried the GroupInfo of the epoch it created.
    const after = await groupInfoRow(conversationId);
    expect(after).toMatchObject({ epoch: 2, signerInstanceId: b2.id });
    expect(Buffer.from(after!.data).toString("base64")).toBe(base64("gi-external-2"));
    expect(after!.createdAt.getTime()).toBe(before!.createdAt.getTime());

    // And it is now an ordinary leaf: it sends at epoch 2 and both others receive.
    const message = await b2.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "app_message",
      epoch: 2,
      payload: base64("from-b2"),
    });
    expect(message.status).toBe(200);
    expect(await recipientsOf(message.body.event.id)).toEqual([a.id, b.id].sort());
  });

  it("an account invited before it installed Allo joins from its first device, with nobody of its own to add it", async () => {
    const a = await TestInstance.register(h.app, accountId("a"));
    const carol = accountId("c");
    const created = await a.signed("post", "/v1/conversations", {
      kind: "group",
      mlsGroupId: mlsGroupId(),
      memberAccountIds: [carol],
      idempotencyKey: key(),
    });
    expect(created.status).toBe(201);
    const conversationId = created.body.conversation.id as string;
    const c = await TestInstance.register(h.app, carol);
    // A group created without an initial commit has no GroupInfo yet: the
    // creator's first commit publishes one. Carol's device then joins.
    expect((await c.signed("get", `/v1/conversations/${conversationId}/group-info`)).body).toEqual({ groupInfo: null });
    const publish = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 0,
      payload: base64("update"),
      commit: { newEpoch: 1, addedLeaves: [], removedLeaves: [], groupInfo: base64("gi-1") },
    });
    expect(publish.status).toBe(200);
    const fetched = await c.signed("get", `/v1/conversations/${conversationId}/group-info`);
    expect(expectParses(groupInfoResponseSchema, fetched.body).groupInfo).toMatchObject({ epoch: 1, signerInstanceId: a.id, data: base64("gi-1") });

    const join = await c.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(c, 1));
    expect(join.status).toBe(200);
    expect(await recipientsOf(join.body.event.id)).toEqual([a.id]);
    expect(await leafRow(conversationId, c.id)).toMatchObject({ state: "active", addedEpoch: 2 });
    const [member] = await h.db
      .select()
      .from(schema.conversationMembers)
      .where(and(eq(schema.conversationMembers.conversationId, conversationId), eq(schema.conversationMembers.accountId, carol)));
    expect(member.state).toBe("joined");
    expect(member.role).toBe("member");
  });

  it("a stale epoch is 409 epoch_conflict with currentEpoch, and writes nothing", async () => {
    const { b2, conversationId } = await dmWithLeaflessSecondDevice();
    const stale = await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 0));
    expect(stale.status).toBe(409);
    const body = expectParses(errorResponseSchema, stale.body);
    expect(body.error.code).toBe("epoch_conflict");
    expect(expectParses(epochConflictDetailsSchema, body.error.details)).toEqual({ currentEpoch: 1 });
    expect(await leafRow(conversationId, b2.id)).toBeNull();
    expect((await conversationRow(conversationId)).lastSeq).toBe(2);
    expect(await groupInfoRow(conversationId)).toMatchObject({ epoch: 1 });

    // The loser of a race: the epoch moved under it. It refetches and retries.
    const race = await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1));
    expect(race.status).toBe(200);
    const late = await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1));
    expect(late.status).toBe(409);
    expect(late.body.error.details).toEqual({ currentEpoch: 2 });
  });

  it("the server does not raise group_info_missing: a commit is judged on its sender, and stores the GroupInfo it carries", async () => {
    // A conversation whose last commit predates the field: no row at all.
    const { b2, conversationId } = await dmWithLeaflessSecondDevice();
    await h.db.delete(schema.conversationGroupInfo).where(eq(schema.conversationGroupInfo.conversationId, conversationId));
    expect((await b2.signed("get", `/v1/conversations/${conversationId}/group-info`)).body).toEqual({ groupInfo: null });
    // Whether the joiner HAS a GroupInfo is the client's business; one that
    // posts an external commit anyway (it got the bytes somewhere) is accepted.
    const join = await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1));
    expect(join.status).toBe(200);
    expect(await groupInfoRow(conversationId)).toMatchObject({ epoch: 2, signerInstanceId: b2.id });
  });
});

describe("resync commit (kind: resync)", () => {
  it("replaces the sender's own leaf in one commit: same instance, membership unchanged, delivered to the others, traffic resumes", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const before = await leafRow(conversationId, b.id);
    expect(before).toMatchObject({ state: "active", addedEpoch: 1 });
    h.realtime.reset();

    const response = await b.signed("post", `/v1/conversations/${conversationId}/events`, resyncCommit(b, 1));
    expect(response.status).toBe(200);
    expect(await recipientsOf(response.body.event.id)).toEqual([a.id]);
    expect(h.realtime.nudges).toEqual([{ instanceIds: [a.id], event: { conversationId } }]);

    const after = await leafRow(conversationId, b.id);
    expect(after).toMatchObject({ id: before!.id, state: "active", addedEpoch: 2, removedEpoch: null });
    const leaves = await h.db.select().from(schema.conversationLeaves).where(eq(schema.conversationLeaves.conversationId, conversationId));
    expect(leaves.map((leaf) => [leaf.instanceId, leaf.state]).sort()).toEqual([[a.id, "active"], [b.id, "active"]].sort());
    const view = await a.signed("get", `/v1/conversations/${conversationId}`);
    expect(view.body.conversation.epoch).toBe(2);
    expect(view.body.conversation.members.map((m: { accountId: string; state: string }) => [m.accountId, m.state]).sort()).toEqual(
      [[a.accountId, "joined"], [b.accountId, "joined"]].sort(),
    );
    expect(await eventKinds(conversationId)).toEqual(["mls_commit", "mls_welcome", "mls_commit"]);
    expect(await groupInfoRow(conversationId)).toMatchObject({ epoch: 2, signerInstanceId: b.id });

    const message = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "app_message",
      epoch: 2,
      payload: base64("after-resync"),
    });
    expect(message.status).toBe(200);
    expect(await recipientsOf(message.body.event.id)).toEqual([b.id]);
  });

  it("is refused for a device that holds no leaf (403), and when the removed or added leaf is not the sender's own (400)", async () => {
    const { a, b, b2, conversationId } = await dmWithLeaflessSecondDevice();
    const noLeaf = await b2.signed("post", `/v1/conversations/${conversationId}/events`, resyncCommit(b2, 1));
    expect(noLeaf.status).toBe(403);
    expect(noLeaf.body.error.code).toBe("forbidden");

    const removesAnother = await b.signed("post", `/v1/conversations/${conversationId}/events`, resyncCommit(b, 1, { removedLeaves: [a.id] }));
    expect(removesAnother.status).toBe(400);
    expect(removesAnother.body.error.code).toBe("validation_failed");
    expect(await leafRow(conversationId, a.id)).toMatchObject({ state: "active" });

    const addsAnother = await b.signed(
      "post",
      `/v1/conversations/${conversationId}/events`,
      resyncCommit(b, 1, { addedLeaves: [{ instanceId: b2.id, accountId: b.accountId }] }),
    );
    expect(addsAnother.status).toBe(400);
    expect(await leafRow(conversationId, b2.id)).toBeNull();

    expect((await conversationRow(conversationId)).currentEpoch).toBe(1);
    expect(await leafRow(conversationId, b.id)).toMatchObject({ state: "active", addedEpoch: 1 });
  });
});

describe("GET /v1/conversations/:id/group-info", () => {
  it("serves the current epoch's GroupInfo to a joined member with or without a leaf, conforming to the schema; every member commit replaces it", async () => {
    const { a, b, b2, conversationId } = await dmWithLeaflessSecondDevice();
    for (const caller of [a, b, b2]) {
      const response = await caller.signed("get", `/v1/conversations/${conversationId}/group-info`);
      expect(response.status).toBe(200);
      const parsed = expectParses(groupInfoResponseSchema, response.body);
      expect(parsed.groupInfo).toMatchObject({ epoch: 1, signerInstanceId: a.id, data: base64("gi-1") });
    }
    // b's ordinary commit (1 → 2) stores the GroupInfo of epoch 2, signed by b.
    const update = await b.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 1,
      payload: base64("update"),
      commit: { newEpoch: 2, addedLeaves: [], removedLeaves: [], groupInfo: base64("gi-2-by-b") },
    });
    expect(update.status).toBe(200);
    const fetched = await b2.signed("get", `/v1/conversations/${conversationId}/group-info`);
    expect(expectParses(groupInfoResponseSchema, fetched.body).groupInfo).toMatchObject({ epoch: 2, signerInstanceId: b.id, data: base64("gi-2-by-b") });
  });

  it("is null for a conversation without one, and for a stored one that is not the current epoch's", async () => {
    const { a, conversationId } = await dmBetween(h.app);
    await h.db.update(schema.conversationGroupInfo).set({ epoch: 0 }).where(eq(schema.conversationGroupInfo.conversationId, conversationId));
    expect((await a.signed("get", `/v1/conversations/${conversationId}/group-info`)).body).toEqual({ groupInfo: null });
    await h.db.delete(schema.conversationGroupInfo).where(eq(schema.conversationGroupInfo.conversationId, conversationId));
    const none = await a.signed("get", `/v1/conversations/${conversationId}/group-info`);
    expect(none.status).toBe(200);
    expect(expectParses(groupInfoResponseSchema, none.body)).toEqual({ groupInfo: null });
  });

  it("is 404 for a stranger and 403 for an account that left or was removed", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("s"));
    const denied = await stranger.signed("get", `/v1/conversations/${conversationId}/group-info`);
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe("not_found");

    await b.signed("post", `/v1/conversations/${conversationId}/leave`).expect(204);
    const left = await b.signed("get", `/v1/conversations/${conversationId}/group-info`);
    expect(left.status).toBe(403);
    expect(left.body.error.code).toBe("forbidden");

    const dm2 = await dmBetween(h.app);
    const kick = await dm2.a.signed("post", `/v1/conversations/${dm2.conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 1,
      payload: base64("kick"),
      commit: { newEpoch: 2, addedLeaves: [], removedLeaves: [dm2.b.id], groupInfo: base64("gi-2") },
    });
    expect(kick.status).toBe(200);
    expect((await dm2.b.signed("get", `/v1/conversations/${dm2.conversationId}/group-info`)).status).toBe(403);
    expect((await a.signed("get", `/v1/conversations/${conversationId}/group-info`)).status).toBe(200);
  });
});

describe("PUT /v1/conversations/:id/group-info", () => {
  it("re-publishes for the current epoch from a device holding an active leaf, and the GET reflects it", async () => {
    const { b, b2, conversationId } = await dmWithLeaflessSecondDevice();
    // The legacy case: nothing stored.
    await h.db.delete(schema.conversationGroupInfo).where(eq(schema.conversationGroupInfo.conversationId, conversationId));
    const response = await b.signed("put", `/v1/conversations/${conversationId}/group-info`, { epoch: 1, data: base64("gi-republished") });
    expect(response.status).toBe(200);
    const parsed = expectParses(groupInfoResponseSchema, response.body);
    expect(parsed.groupInfo).toMatchObject({ epoch: 1, signerInstanceId: b.id, data: base64("gi-republished") });
    const fetched = await b2.signed("get", `/v1/conversations/${conversationId}/group-info`);
    expect(expectParses(groupInfoResponseSchema, fetched.body).groupInfo).toEqual(parsed.groupInfo);

    // A second re-publish for the same epoch replaces the first.
    const again = await b.signed("put", `/v1/conversations/${conversationId}/group-info`, { epoch: 1, data: base64("gi-republished-2") });
    expect(again.status).toBe(200);
    expect(await groupInfoRow(conversationId)).toMatchObject({ epoch: 1, signerInstanceId: b.id });
    expect(Buffer.from((await groupInfoRow(conversationId))!.data).toString("base64")).toBe(base64("gi-republished-2"));

    // And the leafless device may now join from it.
    const join = await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1));
    expect(join.status).toBe(200);
  });

  it("is 409 epoch_conflict for any other epoch, 403 without an active leaf, 404 for a stranger, 400 for a malformed body", async () => {
    const { a, b2, conversationId } = await dmWithLeaflessSecondDevice();
    const stored = await groupInfoRow(conversationId);

    const behind = await a.signed("put", `/v1/conversations/${conversationId}/group-info`, { epoch: 0, data: base64("old") });
    expect(behind.status).toBe(409);
    const body = expectParses(errorResponseSchema, behind.body);
    expect(body.error.code).toBe("epoch_conflict");
    expect(expectParses(epochConflictDetailsSchema, body.error.details)).toEqual({ currentEpoch: 1 });
    const ahead = await a.signed("put", `/v1/conversations/${conversationId}/group-info`, { epoch: 2, data: base64("future") });
    expect(ahead.status).toBe(409);

    const noLeaf = await b2.signed("put", `/v1/conversations/${conversationId}/group-info`, { epoch: 1, data: base64("mine") });
    expect(noLeaf.status).toBe(403);
    expect(noLeaf.body.error.code).toBe("forbidden");

    const stranger = await TestInstance.register(h.app, accountId("s"));
    expect((await stranger.signed("put", `/v1/conversations/${conversationId}/group-info`, { epoch: 1, data: base64("x") })).status).toBe(404);

    const malformed = await a.signed("put", `/v1/conversations/${conversationId}/group-info`, { epoch: 1, data: "not base64!" });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("validation_failed");

    // Nothing above touched the stored row.
    const after = await groupInfoRow(conversationId);
    expect(after).toMatchObject({ epoch: stored!.epoch, signerInstanceId: stored!.signerInstanceId });
    expect(after!.updatedAt.getTime()).toBe(stored!.updatedAt.getTime());
  });
});

describe("mutation: the sender is exactly the added leaf", () => {
  /** Each case fails ONE predicate of the rule; the epoch, leaves and GroupInfo must all be untouched afterwards. */
  async function refused(response: { status: number; body: { error?: { code?: string } } }, conversationId: string, expectedStatus = 400) {
    expect(response.status).toBe(expectedStatus);
    expect(response.body.error?.code).toBe(expectedStatus === 400 ? "validation_failed" : "forbidden");
    expect((await conversationRow(conversationId)).currentEpoch).toBe(1);
    expect((await conversationRow(conversationId)).lastSeq).toBe(2);
    expect(await groupInfoRow(conversationId)).toMatchObject({ epoch: 1 });
  }

  it("another instance of the SAME account is refused, with no leaf created for it", async () => {
    const { b, b2, conversationId } = await dmWithLeaflessSecondDevice();
    const b3 = await TestInstance.register(h.app, b.accountId, { platform: "android" });
    await b.approve(b3);
    const response = await b2.signed(
      "post",
      `/v1/conversations/${conversationId}/events`,
      externalCommit(b2, 1, { addedLeaves: [{ instanceId: b3.id, accountId: b.accountId }] }),
    );
    await refused(response, conversationId);
    expect(await leafRow(conversationId, b3.id)).toBeNull();
    expect(await leafRow(conversationId, b2.id)).toBeNull();
  });

  it("the sender's own instance under another member's account id is refused", async () => {
    const { a, b2, conversationId } = await dmWithLeaflessSecondDevice();
    const response = await b2.signed(
      "post",
      `/v1/conversations/${conversationId}/events`,
      externalCommit(b2, 1, { addedLeaves: [{ instanceId: b2.id, accountId: a.accountId }] }),
    );
    await refused(response, conversationId);
    expect(await leafRow(conversationId, b2.id)).toBeNull();
  });

  it("no added leaf, two added leaves, a removed leaf or a welcome on an external commit are refused", async () => {
    const { b, b2, conversationId } = await dmWithLeaflessSecondDevice();
    const self = { instanceId: b2.id, accountId: b.accountId };
    await refused(await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1, { addedLeaves: [] })), conversationId);
    await refused(
      await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1, { addedLeaves: [self, { instanceId: b.id, accountId: b.accountId }] })),
      conversationId,
    );
    await refused(await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1, { removedLeaves: [b.id] })), conversationId);
    await refused(
      await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1, { welcome: { payload: base64("w"), recipients: [b2.id] } })),
      conversationId,
    );
    expect(await leafRow(conversationId, b2.id)).toBeNull();
    expect(await leafRow(conversationId, b.id)).toMatchObject({ state: "active", addedEpoch: 1 });
  });

  it("a device that already holds an active leaf cannot 'join' again by external commit", async () => {
    const { b, conversationId } = await dmBetween(h.app);
    const response = await b.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b, 1));
    await refused(response, conversationId);
    expect(await leafRow(conversationId, b.id)).toMatchObject({ state: "active", addedEpoch: 1 });
  });
});

describe("mutation: the member-row gate", () => {
  it("an instance whose account has no member row is 404, as a stranger to everything", async () => {
    const { conversationId } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("s"));
    const response = await stranger.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(stranger, 1));
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("not_found");
    expect(await leafRow(conversationId, stranger.id)).toBeNull();
    expect((await conversationRow(conversationId)).currentEpoch).toBe(1);
  });

  it("an account that left, or was removed, is not re-admitted by its own external commit (403)", async () => {
    const { a, b, b2, conversationId } = await dmWithLeaflessSecondDevice();
    await b.signed("post", `/v1/conversations/${conversationId}/leave`).expect(204);
    const afterLeave = await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1));
    expect(afterLeave.status).toBe(403);
    expect(afterLeave.body.error.code).toBe("forbidden");
    expect(await leafRow(conversationId, b2.id)).toBeNull();
    expect((await conversationRow(conversationId)).currentEpoch).toBe(1);

    const dm2 = await dmWithLeaflessSecondDevice();
    const kick = await dm2.a.signed("post", `/v1/conversations/${dm2.conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 1,
      payload: base64("kick"),
      commit: { newEpoch: 2, addedLeaves: [], removedLeaves: [dm2.b.id], groupInfo: base64("gi-2") },
    });
    expect(kick.status).toBe(200);
    const afterRemoval = await dm2.b2.signed("post", `/v1/conversations/${dm2.conversationId}/events`, externalCommit(dm2.b2, 2));
    expect(afterRemoval.status).toBe(403);
    expect(await leafRow(dm2.conversationId, dm2.b2.id)).toBeNull();
    expect((await conversationRow(dm2.conversationId)).currentEpoch).toBe(2);
    // The member with a leaf is unaffected by any of it.
    expect(await leafRow(conversationId, a.id)).toMatchObject({ state: "active" });
  });

  it("a DM stays two accounts: a self-join by a joined member is not a third account, and a non-member's is refused before the DM rule is reached", async () => {
    const { b2, conversationId } = await dmWithLeaflessSecondDevice();
    const join = await b2.signed("post", `/v1/conversations/${conversationId}/events`, externalCommit(b2, 1));
    expect(join.status).toBe(200);
    const members = await h.db.select().from(schema.conversationMembers).where(eq(schema.conversationMembers.conversationId, conversationId));
    expect(members).toHaveLength(2);
  });
});
