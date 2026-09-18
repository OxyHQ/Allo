/**
 * The event log rules: dense seq, the epoch CAS, idempotent replay, fan-out
 * per kind, the welcome to its recipients only, a removed leaf still learning
 * the commit that removed it, and who may add or remove whom.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import {
  epochConflictDetailsSchema,
  errorResponseSchema,
  listEventsResponseSchema,
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
const key = () => `k-${process.pid}-${++keyCounter}`;

async function recipientsOf(eventId: string): Promise<string[]> {
  const rows = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.eventId, eventId));
  return rows.map((row) => row.instanceId).sort();
}

/** a's second device, approved, stocked, and added to the DM by a's first device (a commit at epoch 1 → 2). */
async function withSecondDevice() {
  const dm = await dmBetween(h.app);
  const a2 = await TestInstance.register(h.app, dm.a.accountId, { platform: "ios" });
  await dm.a.approve(a2);
  await a2.stockKeyPackages(2);
  const add = await dm.a.signed("post", `/v1/conversations/${dm.conversationId}/events`, {
    idempotencyKey: key(),
    kind: "mls_commit",
    epoch: 1,
    payload: base64("add-a2"),
    commit: {
      newEpoch: 2,
      addedLeaves: [{ instanceId: a2.id, accountId: dm.a.accountId }],
      removedLeaves: [],
      welcome: { payload: base64("welcome-a2"), recipients: [a2.id] },
    },
  });
  expect(add.status).toBe(200);
  return { ...dm, a2, addCommitId: add.body.event.id as string };
}

describe("POST /v1/conversations/:id/events", () => {
  it("assigns dense seqs, delivers an app_message to every active leaf but the sender, and nudges them", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    h.realtime.reset();
    const first = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "app_message",
      epoch: 1,
      payload: base64("ciphertext-1"),
    });
    expect(first.status).toBe(200);
    const parsed = expectParses(submitEventResponseSchema, first.body);
    expect(parsed.event.seq).toBe(3);
    expect(await recipientsOf(parsed.event.id)).toEqual([b.id]);
    expect(h.realtime.nudges).toEqual([{ instanceIds: [b.id], event: { conversationId } }]);

    const second = await b.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_proposal",
      epoch: 1,
      payload: base64("proposal"),
    });
    expect(second.body.event.seq).toBe(4);
    expect(await recipientsOf(second.body.event.id)).toEqual([a.id]);
  });

  it("refuses a stale epoch with 409 epoch_conflict carrying currentEpoch, and writes nothing", async () => {
    const { a, conversationId } = await dmBetween(h.app);
    const response = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "app_message",
      epoch: 0,
      payload: base64("late"),
    });
    expect(response.status).toBe(409);
    const body = expectParses(errorResponseSchema, response.body);
    expect(body.error.code).toBe("epoch_conflict");
    expect(expectParses(epochConflictDetailsSchema, body.error.details)).toEqual({ currentEpoch: 1 });
    const [row] = await h.db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(row.lastSeq).toBe(2);

    const ahead = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 2,
      payload: base64("c"),
      commit: { newEpoch: 3, addedLeaves: [], removedLeaves: [] },
    });
    expect(ahead.status).toBe(409);
  });

  it("replays the same (instance, idempotencyKey) as the original event with 200 and no second write; a different body is a conflict", async () => {
    const { a, conversationId } = await dmBetween(h.app);
    const k = key();
    const body = { idempotencyKey: k, kind: "app_message", epoch: 1, payload: base64("once") };
    const first = await a.signed("post", `/v1/conversations/${conversationId}/events`, body);
    h.realtime.reset();
    const replay = await a.signed("post", `/v1/conversations/${conversationId}/events`, body);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(h.realtime.nudges).toEqual([]);
    const events = await h.db.select().from(schema.conversationEvents).where(eq(schema.conversationEvents.conversationId, conversationId));
    expect(events.filter((e) => e.idempotencyKey === k)).toHaveLength(1);

    const different = await a.signed("post", `/v1/conversations/${conversationId}/events`, { ...body, payload: base64("twice") });
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("idempotency_conflict");

    // The key is scoped to the sender: another instance may use the same one.
    const { b: other } = { b: await TestInstance.register(h.app, accountId("z")) };
    const unrelated = await other.signed("post", "/v1/conversations", {
      kind: "group",
      mlsGroupId: mlsGroupId(),
      memberAccountIds: [],
      idempotencyKey: "x",
    });
    const theirs = await other.signed("post", `/v1/conversations/${unrelated.body.conversation.id}/events`, {
      idempotencyKey: k,
      kind: "app_message",
      epoch: 0,
      payload: base64("mine"),
    });
    expect(theirs.status).toBe(200);
  });

  it("a commit adding a leaf: delivered to the leaves active at the old epoch, the welcome to its recipients ONLY, membership upserted", async () => {
    const { a, b, a2, conversationId, addCommitId } = await withSecondDevice();
    // The commit went to b (active at epoch 1), not to a2 (not yet a leaf) and not to the sender.
    expect(await recipientsOf(addCommitId)).toEqual([b.id]);
    const events = await h.db
      .select()
      .from(schema.conversationEvents)
      .where(eq(schema.conversationEvents.conversationId, conversationId))
      .orderBy(asc(schema.conversationEvents.seq));
    const welcome = events[events.length - 1];
    expect(welcome.kind).toBe("mls_welcome");
    expect(welcome.epoch).toBe(2);
    expect(welcome.seq).toBe(4);
    expect(await recipientsOf(welcome.id)).toEqual([a2.id]);
    // The new leaf is active at the new epoch; the epoch moved.
    const view = await a2.signed("get", `/v1/conversations/${conversationId}`);
    expect(view.body.conversation.epoch).toBe(2);
    expect(view.body.conversation.myLeafState).toBe("active");
    expect(view.body.conversation.leaves.find((l: { instanceId: string }) => l.instanceId === a2.id).addedEpoch).toBe(2);
    // a2 can now send at epoch 2 and both other leaves receive.
    const msg = await a2.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "app_message",
      epoch: 2,
      payload: base64("from-a2"),
    });
    expect(msg.status).toBe(200);
    expect(await recipientsOf(msg.body.event.id)).toEqual([a.id, b.id].sort());
  });

  it("a commit removing a leaf: the removed leaf STILL receives that commit, then nothing after it", async () => {
    const { a, b, a2, conversationId } = await withSecondDevice();
    const remove = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 2,
      payload: base64("remove-a2"),
      commit: { newEpoch: 3, addedLeaves: [], removedLeaves: [a2.id] },
    });
    expect(remove.status).toBe(200);
    expect(await recipientsOf(remove.body.event.id)).toEqual([a2.id, b.id].sort());

    const after = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "app_message",
      epoch: 3,
      payload: base64("after"),
    });
    expect(await recipientsOf(after.body.event.id)).toEqual([b.id]);

    // The removed leaf may not send; a's account is still a member (a's first device is active).
    const denied = await a2.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "app_message",
      epoch: 3,
      payload: base64("ghost"),
    });
    expect(denied.status).toBe(403);
    const view = await a.signed("get", `/v1/conversations/${conversationId}`);
    expect(view.body.conversation.members.find((m: { accountId: string }) => m.accountId === a.accountId).state).toBe("joined");
    const leaf = view.body.conversation.leaves.find((l: { instanceId: string }) => l.instanceId === a2.id);
    expect(leaf.state).toBe("removed");
  });

  it("removing an account's last leaf marks the member removed (by another) or left (by itself)", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    // b removes itself: left.
    const self = await b.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 1,
      payload: base64("bye"),
      commit: { newEpoch: 2, addedLeaves: [], removedLeaves: [b.id] },
    });
    expect(self.status).toBe(200);
    let view = await a.signed("get", `/v1/conversations/${conversationId}`);
    expect(view.body.conversation.members.find((m: { accountId: string }) => m.accountId === b.accountId).state).toBe("left");

    // Elsewhere: the owner removes the other: removed.
    const dm2 = await dmBetween(h.app);
    const byOwner = await dm2.a.signed("post", `/v1/conversations/${dm2.conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 1,
      payload: base64("kick"),
      commit: { newEpoch: 2, addedLeaves: [], removedLeaves: [dm2.b.id] },
    });
    expect(byOwner.status).toBe(200);
    view = await dm2.a.signed("get", `/v1/conversations/${dm2.conversationId}`);
    expect(view.body.conversation.members.find((m: { accountId: string }) => m.accountId === dm2.b.accountId).state).toBe("removed");
  });

  it("a joined member that never had a leaf stays joined through commits that add and remove OTHER accounts' leaves", async () => {
    // Carol has no instance and no leaf: she was invited before installing Allo. The
    // rule is "removed only when the commit removed the account's LAST leaf", not
    // "removed whenever the account has no active leaf after the commit".
    const a = await TestInstance.register(h.app, accountId("a"));
    const b = await TestInstance.register(h.app, accountId("b"));
    await b.stockKeyPackages(2);
    const carol = accountId("c");
    const created = await a.signed("post", "/v1/conversations", {
      kind: "group",
      mlsGroupId: mlsGroupId(),
      memberAccountIds: [b.accountId, carol],
      idempotencyKey: key(),
    });
    expect(created.status).toBe(201);
    const conversationId = created.body.conversation.id as string;
    const memberStates = async () => {
      const rows = await h.db.select().from(schema.conversationMembers).where(eq(schema.conversationMembers.conversationId, conversationId));
      return Object.fromEntries(rows.map((row) => [row.accountId, row.state]));
    };
    expect(await memberStates()).toEqual({ [a.accountId]: "joined", [b.accountId]: "joined", [carol]: "joined" });

    // Alice adds Bob's leaf (epoch 0 → 1): Carol, untouched by the commit, is still joined.
    const add = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 0,
      payload: base64("add-b"),
      commit: {
        newEpoch: 1,
        addedLeaves: [{ instanceId: b.id, accountId: b.accountId }],
        removedLeaves: [],
        welcome: { payload: base64("welcome-b"), recipients: [b.id] },
      },
    });
    expect(add.status).toBe(200);
    expect(await memberStates()).toEqual({ [a.accountId]: "joined", [b.accountId]: "joined", [carol]: "joined" });

    // Alice removes Bob's only leaf (1 → 2): Bob lost his last leaf and is removed; Carol never had one and is still joined.
    const remove = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 1,
      payload: base64("remove-b"),
      commit: { newEpoch: 2, addedLeaves: [], removedLeaves: [b.id] },
    });
    expect(remove.status).toBe(200);
    expect(await memberStates()).toEqual({ [a.accountId]: "joined", [b.accountId]: "removed", [carol]: "joined" });
    const view = await a.signed("get", `/v1/conversations/${conversationId}`);
    expect(view.body.conversation.members.find((m: { accountId: string }) => m.accountId === carol).state).toBe("joined");
  });

  it("authorization: a member may not remove another account's leaf, a dm may not gain a third account, an added instance must be real and active", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const notAllowed = await b.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 1,
      payload: base64("kick-owner"),
      commit: { newEpoch: 2, addedLeaves: [], removedLeaves: [a.id] },
    });
    expect(notAllowed.status).toBe(403);
    expect(notAllowed.body.error.code).toBe("forbidden");

    const c = await TestInstance.register(h.app, accountId("c"));
    const third = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 1,
      payload: base64("third"),
      commit: { newEpoch: 2, addedLeaves: [{ instanceId: c.id, accountId: c.accountId }], removedLeaves: [] },
    });
    expect(third.status).toBe(403);

    const wrongAccount = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 1,
      payload: base64("lie"),
      commit: { newEpoch: 2, addedLeaves: [{ instanceId: c.id, accountId: b.accountId }], removedLeaves: [] },
    });
    expect(wrongAccount.status).toBe(400);

    const badWelcome = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "mls_commit",
      epoch: 1,
      payload: base64("w"),
      commit: { newEpoch: 2, addedLeaves: [], removedLeaves: [], welcome: { payload: base64("w"), recipients: [b.id] } },
    });
    expect(badWelcome.status).toBe(400);

    // Nothing above moved the epoch.
    const [row] = await h.db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
    expect(row.currentEpoch).toBe(1);
    expect(row.lastSeq).toBe(2);
  });

  it("a stranger gets not_found, a member with no leaf gets forbidden, and the schema refuses commit info on a message", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const stranger = await TestInstance.register(h.app, accountId("s"));
    const denied = await stranger.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "app_message",
      epoch: 1,
      payload: base64("x"),
    });
    expect(denied.status).toBe(404);

    const b2 = await TestInstance.register(h.app, b.accountId);
    await b.approve(b2);
    const noLeaf = await b2.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "app_message",
      epoch: 1,
      payload: base64("x"),
    });
    expect(noLeaf.status).toBe(403);

    const malformed = await a.signed("post", `/v1/conversations/${conversationId}/events`, {
      idempotencyKey: key(),
      kind: "app_message",
      epoch: 1,
      payload: base64("x"),
      commit: { newEpoch: 2, addedLeaves: [], removedLeaves: [] },
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("validation_failed");
  });

  it("keeps the blobs an event declares", async () => {
    const { a, conversationId } = await dmBetween(h.app);
    const upload = await a.uploadBlob(Buffer.from("encrypted media bytes"));
    expect(upload.status).toBe(201);
    let [blob] = await h.db.select().from(schema.blobs).where(eq(schema.blobs.id, upload.body.blobId));
    expect(blob.expiresAt).not.toBeNull();
    await a
      .signed("post", `/v1/conversations/${conversationId}/events`, {
        idempotencyKey: key(),
        kind: "app_message",
        epoch: 1,
        payload: base64("media-message"),
        blobIds: [upload.body.blobId],
      })
      .expect(200);
    [blob] = await h.db.select().from(schema.blobs).where(eq(schema.blobs.id, upload.body.blobId));
    expect(blob.expiresAt).toBeNull();
  });
});

describe("GET /v1/conversations/:id/events", () => {
  it("pages by seq with hasMore, returns raw ciphertext events that parse with the schema, and is members-only", async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    for (let i = 0; i < 3; i += 1) {
      await a
        .signed("post", `/v1/conversations/${conversationId}/events`, { idempotencyKey: key(), kind: "app_message", epoch: 1, payload: base64(`m${i}`) })
        .expect(200);
    }
    const page = await b.signed("get", `/v1/conversations/${conversationId}/events?after=2&limit=2`);
    expect(page.status).toBe(200);
    const parsed = expectParses(listEventsResponseSchema, page.body);
    expect(parsed.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.events[0].payload).toBe(base64("m0"));
    expect(parsed.events[0].senderInstanceId).toBe(a.id);

    const rest = await b.signed("get", `/v1/conversations/${conversationId}/events?after=4`);
    expect(rest.body.events.map((e: { seq: number }) => e.seq)).toEqual([5]);
    expect(rest.body.hasMore).toBe(false);

    const all = await b.signed("get", `/v1/conversations/${conversationId}/events`);
    expect(all.body.events.map((e: { kind: string }) => e.kind)).toEqual(["mls_commit", "mls_welcome", "app_message", "app_message", "app_message"]);

    const bad = await b.signed("get", `/v1/conversations/${conversationId}/events?limit=0`);
    expect(bad.status).toBe(400);

    const stranger = await TestInstance.register(h.app, accountId("s"));
    expect((await stranger.signed("get", `/v1/conversations/${conversationId}/events`)).status).toBe(404);
  });
});
