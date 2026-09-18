/**
 * Members without an Allo instance, the real SDK against the real backend.
 *
 * A conversation may name an account the server has never seen. The core
 * package proves the client half over its fake server (`core/src/__tests__/reach.test.ts`);
 * this suite proves THIS server's half: the create succeeds with a joined,
 * leafless member row, the account's first registration nudges the
 * conversation's active leaves over a real socket, the elector's commit adds
 * the new leaf, the held messages arrive in order — and the member row is
 * `joined` the whole way, never `removed` by a commit that did not touch it.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import * as schema from "../../db/schema";
import { logger } from "../../utils/logger";
import { Harness, stopAll, texts, waitFor, waitForText, waitJoined, type TestClient } from "./harness";

const h = new Harness();
beforeAll(() => h.boot(), 180_000);
afterAll(() => h.shutdown());

const pendingOf = (c: TestClient, conversationId: string) => c.client.messages.timeline(conversationId).filter((i) => i.sendState === "pending");
const textItems = (c: TestClient, conversationId: string) => c.client.messages.timeline(conversationId).filter((i) => i.content.kind === "text");

async function memberRow(conversationId: string, accountId: string) {
  const [row] = await h.db
    .select()
    .from(schema.conversationMembers)
    .where(and(eq(schema.conversationMembers.conversationId, conversationId), eq(schema.conversationMembers.accountId, accountId)));
  expect(row, `member row of ${accountId}`).toBeDefined();
  return row;
}

async function eventsOf(conversationId: string) {
  return h.db
    .select({ kind: schema.conversationEvents.kind, epoch: schema.conversationEvents.epoch, senderInstanceId: schema.conversationEvents.senderInstanceId })
    .from(schema.conversationEvents)
    .where(eq(schema.conversationEvents.conversationId, conversationId))
    .orderBy(asc(schema.conversationEvents.seq));
}

async function leavesOf(conversationId: string) {
  return h.db.select().from(schema.conversationLeaves).where(eq(schema.conversationLeaves.conversationId, conversationId));
}

/** The backend's request log (method, route template, status) since `since`, from the mocked logger. */
function requestLog(since = 0) {
  return vi
    .mocked(logger.info)
    .mock.calls.slice(since)
    .filter(([message]) => message === "HTTP request completed")
    .map(([, meta]) => meta as { method: string; route: string; status: number });
}
const logMark = () => vi.mocked(logger.info).mock.calls.length;

describe("members without an instance", () => {
  it("(a) a DM with an account that has no instance: created, two texts held, then delivered in order once Bob installs; Bob's member row joined throughout", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    await waitFor(() => alice.client.sync.state() === "live");
    const mark = logMark();

    // The server has never seen Bob: the lookup is a 404 and the create still succeeds.
    const conv = await alice.client.conversations.createDirect(bobId);
    expect(conv.kind).toBe("dm");
    expect(conv.joined).toBe(true);
    expect(conv.memberAccountIds.sort()).toEqual([aliceId, bobId].sort());
    expect(conv.unreachableMemberAccountIds).toEqual([bobId]);
    expect(requestLog(mark).some((r) => r.route.endsWith("/accounts/:accountId/instances") && r.status === 200)).toBe(true); // an empty listing, not an error
    const bobAtCreate = await memberRow(conv.id, bobId);
    expect(bobAtCreate.state).toBe("joined");
    expect(bobAtCreate.leftAt).toBeNull();
    // Only Alice's leaf, no commit: there was nobody to add.
    expect((await leavesOf(conv.id)).map((l) => l.instanceId)).toEqual([alice.client.instanceId]);
    expect(await eventsOf(conv.id)).toEqual([]);

    // Held: pending, marked, and the server never sees them.
    const first = h.unique("first");
    const second = h.unique("second");
    const k1 = await alice.client.messages.send(conv.id, first);
    const k2 = await alice.client.messages.send(conv.id, second);
    await alice.client.sync.flush();
    await alice.client.sync.now();
    const held = pendingOf(alice, conv.id);
    expect(held.map((i) => i.localKey)).toEqual([k1, k2]);
    expect(held.every((i) => i.holdReason === "no_reachable_member")).toBe(true);
    expect(alice.client.conversations.get(conv.id)?.lastMessage?.holdReason).toBe("no_reachable_member");
    expect(await eventsOf(conv.id)).toEqual([]);
    expect(requestLog(mark).filter((r) => r.method === "POST" && r.route.endsWith("/conversations/:id/events"))).toEqual([]);

    // Bob installs Allo: a bootstrap registration, active at once. The server nudges Alice's leaf; her
    // elector finds the instance, and once its key packages are up (the SDK's 5 s retry) commits the Add.
    const bob = await h.makeClient(bobId, "Bob", "ios");
    expect(bob.client.instance.state()).toBe("active");
    await waitJoined(bob, conv.id, 30_000);
    await waitForText(bob, conv.id, second, 30_000);
    expect(texts(bob.client.messages.timeline(conv.id))).toEqual([first, second]);
    expect(bob.client.conversations.get(conv.id)?.memberAccountIds.sort()).toEqual([aliceId, bobId].sort());
    expect(bob.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([]);

    // Alice's echoes left `pending`: sequenced, no hold reason.
    await waitFor(() => pendingOf(alice, conv.id).length === 0);
    const sent = textItems(alice, conv.id);
    expect(sent.map((i) => i.localKey)).toEqual([k1, k2]);
    expect(sent.every((i) => i.seq !== null && i.holdReason === undefined && i.sendState !== "pending")).toBe(true);
    expect(alice.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([]);

    // The server's view: Bob's row is the SAME joined row (never removed and re-joined), exactly one
    // commit — Alice's — added his leaf, and that leaf is active at the epoch the commit moved to.
    const bobAfter = await memberRow(conv.id, bobId);
    expect(bobAfter.state).toBe("joined");
    expect(bobAfter.leftAt).toBeNull();
    expect(bobAfter.joinedAt.getTime()).toBe(bobAtCreate.joinedAt.getTime());
    const events = await eventsOf(conv.id);
    const commits = events.filter((e) => e.kind === "mls_commit");
    expect(commits).toHaveLength(1);
    expect(commits[0].senderInstanceId).toBe(alice.client.instanceId);
    expect(events.filter((e) => e.kind === "mls_welcome")).toHaveLength(1);
    // Alice's two texts; Bob's encrypted `delivered` receipt is a third app_message that may or may not have landed yet.
    expect(events.filter((e) => e.kind === "app_message" && e.senderInstanceId === alice.client.instanceId)).toHaveLength(2);
    const [row] = await h.db.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id));
    const bobLeaf = (await leavesOf(conv.id)).find((l) => l.instanceId === bob.client.instanceId);
    expect(bobLeaf?.state).toBe("active");
    expect(bobLeaf?.addedEpoch).toBe(row.currentEpoch);
    expect(requestLog(mark).filter((r) => r.status === 409)).toEqual([]);

    // And it keeps working both ways.
    const back = h.unique("hi alice");
    await bob.client.messages.send(conv.id, back);
    await waitForText(alice, conv.id, back);
    await stopAll(alice, bob);
  }, 120_000);

  it("(b) a group of Alice, Bob and instance-less Carol: Bob reads at once, Carol is welcomed when she installs and reads only what follows; her member row joined throughout", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const carolId = h.account("carol");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    const bob = await h.makeClient(bobId, "Bob", "ios");
    await waitFor(() => alice.client.sync.state() === "live" && bob.client.sync.state() === "live");
    const mark = logMark();

    const group = await alice.client.conversations.createGroup([bobId, carolId]);
    expect(group.kind).toBe("group");
    expect(group.memberAccountIds.sort()).toEqual([aliceId, bobId, carolId].sort());
    expect(group.unreachableMemberAccountIds).toEqual([carolId]);
    await waitJoined(bob, group.id);
    expect(bob.client.conversations.get(group.id)?.unreachableMemberAccountIds).toEqual([carolId]);

    // The first commit (the initial one, adding Bob) did not touch Carol: she is joined, with no leaf.
    const carolAtCreate = await memberRow(group.id, carolId);
    expect(carolAtCreate.state).toBe("joined");
    expect((await eventsOf(group.id)).filter((e) => e.kind === "mls_commit")).toHaveLength(1);
    expect((await leavesOf(group.id)).map((l) => l.accountId).sort()).toEqual([aliceId, bobId].sort());

    // Bob can read it, so nothing is held.
    const hiBoth = h.unique("hi both");
    const key = await alice.client.messages.send(group.id, hiBoth);
    await waitForText(bob, group.id, hiBoth);
    const echo = alice.client.messages.timeline(group.id).find((i) => i.localKey === key);
    expect(echo?.holdReason).toBeUndefined();
    expect(echo?.seq).not.toBeNull();

    // Carol installs: the server nudges Alice's and Bob's leaves; the elector (Alice, the lowest leaf) adds her.
    const carol = await h.makeClient(carolId, "Carol", "android");
    await waitJoined(carol, group.id, 30_000);
    expect(carol.client.conversations.get(group.id)?.unreachableMemberAccountIds).toEqual([]);
    expect(carol.client.conversations.get(group.id)?.memberAccountIds.sort()).toEqual([aliceId, bobId, carolId].sort());
    await waitFor(() => alice.client.conversations.get(group.id)?.unreachableMemberAccountIds.length === 0);
    await waitFor(() => bob.client.conversations.get(group.id)?.unreachableMemberAccountIds.length === 0);

    // No cross-account history: Alice's NEXT message reaches her; the earlier one never can.
    const hiThree = h.unique("hi three");
    await alice.client.messages.send(group.id, hiThree);
    await waitForText(carol, group.id, hiThree, 15_000);
    await waitForText(bob, group.id, hiThree);
    expect(texts(carol.client.messages.timeline(group.id))).toEqual([hiThree]);

    const carolAfter = await memberRow(group.id, carolId);
    expect(carolAfter.state).toBe("joined");
    expect(carolAfter.leftAt).toBeNull();
    expect(carolAfter.joinedAt.getTime()).toBe(carolAtCreate.joinedAt.getTime());
    const commits = (await eventsOf(group.id)).filter((e) => e.kind === "mls_commit");
    expect(commits).toHaveLength(2);
    expect(commits.every((c) => c.senderInstanceId === alice.client.instanceId)).toBe(true);
    expect((await leavesOf(group.id)).filter((l) => l.state === "active").map((l) => l.accountId).sort()).toEqual([aliceId, bobId, carolId].sort());
    expect(requestLog(mark).filter((r) => r.status === 409)).toEqual([]);
    await stopAll(alice, bob, carol);
  }, 120_000);

  it("the server held ciphertext only", async () => {
    expect(h.sent.length).toBeGreaterThan(0);
    const payloads = await h.allPayloads();
    for (const text of h.sent) {
      const needle = Buffer.from(text, "utf8");
      expect(payloads.some((p) => p.includes(needle)), `plaintext "${text}" in a stored payload`).toBe(false);
    }
  });
});
