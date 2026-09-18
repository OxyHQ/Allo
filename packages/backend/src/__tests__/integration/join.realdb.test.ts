/**
 * Self-join by MLS external commit and lost-state resync, the real SDK against
 * the real backend.
 *
 * The core package proves the client half over its fake server
 * (`core/src/__tests__/join.test.ts`, j1–j8) and the platform suite proves the
 * server's rules with hand-made payloads (`platform/groupInfo.realdb.test.ts`).
 * This suite is the two halves together: the GroupInfo the SDK PUTs and posts
 * is what THIS server stores and hands back, the external commit the SDK builds
 * from it is what this server's `appendClientEvent` accepts, and every leaf,
 * member, delivery and GroupInfo row is read back from Postgres. The commit's
 * `kind` is not a column: an external commit is recognised on the server by
 * its sender holding no leaf beforehand, no welcome following it, its leaf
 * active at the new epoch at once, and the stored GroupInfo signed by it.
 *
 * Scenario 4 is the one that matters most: the server accepts a forged joiner
 * (a joined member row is all it checks) and the honest clients must refuse
 * it. What happens to the honest clients afterwards is measured and asserted
 * as measured, not hidden.
 */

import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { CryptoEngine, base64Decode, base64Encode, generateSigningKey, keyPackageRefFromWire, signRequest, type SigningKeyPair } from "@allo/core";
import { INSTANCE_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER, type SubmitEventRequest } from "@allo/shared-types";
import * as schema from "../../db/schema";
import { logger } from "../../utils/logger";
import { Harness, stopAll, texts, TOKEN_PREFIX, waitFor, waitForText, waitJoined, type TestClient } from "./harness";

const h = new Harness();
beforeAll(() => h.boot(), 180_000);
afterAll(() => h.shutdown());

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function conversationRow(conversationId: string) {
  const [row] = await h.db.select().from(schema.conversations).where(eq(schema.conversations.id, conversationId));
  expect(row, `conversation ${conversationId}`).toBeDefined();
  return row;
}

async function memberRows(conversationId: string) {
  return h.db.select().from(schema.conversationMembers).where(eq(schema.conversationMembers.conversationId, conversationId));
}

async function eventsOf(conversationId: string) {
  return h.db
    .select({
      id: schema.conversationEvents.id,
      seq: schema.conversationEvents.seq,
      kind: schema.conversationEvents.kind,
      epoch: schema.conversationEvents.epoch,
      senderInstanceId: schema.conversationEvents.senderInstanceId,
      payload: schema.conversationEvents.payload,
    })
    .from(schema.conversationEvents)
    .where(eq(schema.conversationEvents.conversationId, conversationId))
    .orderBy(asc(schema.conversationEvents.seq));
}

const commitsOf = async (conversationId: string) => (await eventsOf(conversationId)).filter((e) => e.kind === "mls_commit");
const welcomesOf = async (conversationId: string) => (await eventsOf(conversationId)).filter((e) => e.kind === "mls_welcome");

async function leavesOf(conversationId: string) {
  return h.db.select().from(schema.conversationLeaves).where(eq(schema.conversationLeaves.conversationId, conversationId));
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

async function recipientsOf(eventId: string): Promise<string[]> {
  const rows = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.eventId, eventId));
  return rows.map((row) => row.instanceId).sort();
}

/** The stored bytes are a real `mls_group_info`, not a placeholder: the engine can read them. */
async function expectRealGroupInfo(conversationId: string) {
  const row = await groupInfoRow(conversationId);
  expect(row, `GroupInfo of ${conversationId}`).not.toBeNull();
  const e = await CryptoEngine.create();
  expect(e.peek(new Uint8Array(row!.data)).kind).toBe("group_info");
  return row!;
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
const conflictsSince = (mark: number) => requestLog(mark).filter((r) => r.status === 409);

/**
 * Every distinct `joinState` a client's view of `conversationId` passes
 * through, in order. Subscribed BEFORE `start()` so the first sync's record is
 * seen; the emitter is synchronous, so nothing between two states is missed.
 */
function recordJoinStates(c: TestClient, conversationId: string): string[] {
  const seen: string[] = [];
  const note = () => {
    const state = c.client.conversations.get(conversationId)?.joinState;
    if (state && seen[seen.length - 1] !== state) seen.push(state);
  };
  note();
  c.client.subscribe("conversations", note);
  return seen;
}

/** A signed request straight at the real server from an arbitrary key: what the SDK refuses to do on its own. */
async function signedFetch(accountId: string, instanceId: string, key: SigningKeyPair, method: "GET" | "POST" | "PUT", pathWithQuery: string, body?: unknown) {
  const text = body === undefined ? "" : JSON.stringify(body);
  const timestampMs = Date.now();
  const signature = signRequest(key, { method, pathWithQuery, timestampMs, bodySha256Hex: createHash("sha256").update(text).digest("hex") });
  const res = await fetch(`${h.baseUrl}${pathWithQuery}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN_PREFIX}${accountId}`,
      [INSTANCE_HEADER]: instanceId,
      [TIMESTAMP_HEADER]: String(timestampMs),
      [SIGNATURE_HEADER]: signature,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : text,
  });
  const json = res.status === 204 ? null : ((await res.json().catch(() => null)) as Record<string, unknown> | null);
  return { status: res.status, body: json };
}

describe("self-join by external commit", () => {
  it("(1) the elector offline: Alice's DM with a not-yet-installed Bob, Alice stopped; Bob joins himself (joining → joined), Alice follows on restart, messages both ways", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    await waitFor(() => alice.client.sync.state() === "live");

    // The server has never seen Bob, so there is nobody to add and no initial commit; the creator
    // published the epoch-0 GroupInfo itself, by PUT, and that is what Bob will join from.
    const conv = await alice.client.conversations.createDirect(bobId);
    expect(conv.joined).toBe(true);
    expect(conv.joinState).toBe("joined");
    expect(conv.unreachableMemberAccountIds).toEqual([bobId]);
    expect(await eventsOf(conv.id)).toEqual([]);
    expect(await expectRealGroupInfo(conv.id)).toMatchObject({ epoch: 0, signerInstanceId: alice.client.instanceId });
    const whileOut = h.unique("while you were out");
    const held = await alice.client.messages.send(conv.id, whileOut);
    await alice.client.sync.flush();
    await alice.client.stop();
    const mark = logMark();

    // Bob installs. Nobody is online to add him: he finds the GroupInfo and joins by himself.
    const bob = await h.makeClient(bobId, "Bob", "ios", { start: false });
    const states = recordJoinStates(bob, conv.id);
    await bob.client.start();
    expect(bob.client.instance.state()).toBe("active");
    await waitJoined(bob, conv.id, 30_000);
    expect(states).toEqual(["joining", "joined"]);
    expect(bob.client.conversations.get(conv.id)).toMatchObject({ joinState: "joined", epoch: 1, unreachableMemberAccountIds: [] });
    expect(bob.client.conversations.get(conv.id)?.memberAccountIds.sort()).toEqual([aliceId, bobId].sort());

    // The server's view: one commit, Bob's, at epoch 0; no welcome; his leaf active at epoch 1 at once;
    // the GroupInfo of epoch 1 signed by him; the commit delivered to Alice's leaf and to nobody else.
    const commits = await commitsOf(conv.id);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ senderInstanceId: bob.client.instanceId, epoch: 0 });
    expect(await welcomesOf(conv.id)).toEqual([]);
    expect((await conversationRow(conv.id)).currentEpoch).toBe(1);
    expect(await leafRow(conv.id, bob.client.instanceId!)).toMatchObject({ state: "active", addedEpoch: 1, removedEpoch: null, accountId: bobId });
    expect(await leafRow(conv.id, alice.client.instanceId!)).toMatchObject({ state: "active", addedEpoch: 0 });
    expect(await expectRealGroupInfo(conv.id)).toMatchObject({ epoch: 1, signerInstanceId: bob.client.instanceId });
    expect(await recipientsOf(commits[0].id)).toEqual([alice.client.instanceId]);
    expect((await memberRows(conv.id)).map((m) => [m.accountId, m.state]).sort()).toEqual([[aliceId, "joined"], [bobId, "joined"]].sort());
    const gets = requestLog(mark).filter((r) => r.method === "GET" && r.route.endsWith("/group-info"));
    expect(gets.length).toBeGreaterThanOrEqual(1);
    expect(gets.every((r) => r.status === 200)).toBe(true);
    expect(conflictsSince(mark)).toEqual([]); // nobody to race

    // Alice restarts on the same device, admits Bob's commit (his instance is his account's bootstrap
    // root), the held message goes out, and traffic flows both ways. The elector never adds him after the fact.
    const alice2 = await h.makeClient(aliceId, "Alice", "web", { storage: alice.storage, secrets: alice.secrets });
    expect(alice2.client.instanceId).toBe(alice.client.instanceId);
    await waitFor(() => alice2.client.conversations.get(conv.id)?.epoch === 1, 20_000);
    expect(alice2.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([]);
    await waitForText(bob, conv.id, whileOut, 20_000);
    const echo = alice2.client.messages.timeline(conv.id).find((i) => i.localKey === held);
    expect(echo?.holdReason).toBeUndefined();
    expect(echo?.seq).not.toBeNull();
    const back = h.unique("hi alice");
    await bob.client.messages.send(conv.id, back);
    await waitForText(alice2, conv.id, back);
    const forth = h.unique("hi bob");
    await alice2.client.messages.send(conv.id, forth);
    await waitForText(bob, conv.id, forth);
    expect(await commitsOf(conv.id)).toHaveLength(1);
    expect(conflictsSince(mark)).toEqual([]);
    await stopAll(alice2, bob);
  }, 120_000);

  it("(2) a second device with the first offline: approved and then alone, Bob's desktop joins every conversation by itself; Alice admits it and her next message decrypts there", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    const bobIos = await h.makeClient(bobId, "Bob iOS", "ios");
    const conv = await alice.client.conversations.createDirect(bobId);
    await waitJoined(bobIos, conv.id);
    const before = h.unique("before desktop");
    await alice.client.messages.send(conv.id, before);
    await waitForText(bobIos, conv.id, before);

    // The desktop enrols; the phone approves it and is stopped before the desktop has a key package it
    // could be added with, so the elector path is closed.
    const bobDesktop = await h.makeClient(bobId, "Bob desktop", "desktop");
    expect(bobDesktop.client.instance.state()).toBe("pending-approval");
    await bobIos.client.instance.refreshPending();
    const [pending] = bobIos.client.instance.pending();
    expect(pending.instance.id).toBe(bobDesktop.client.instanceId);
    await bobIos.client.instance.approve(pending.instance.id, pending.challenge);
    await bobIos.client.stop();
    const epochBefore = (await conversationRow(conv.id)).currentEpoch;
    expect((await leavesOf(conv.id)).filter((l) => l.accountId === bobId && l.state === "active")).toHaveLength(1);
    expect(await leafRow(conv.id, bobDesktop.client.instanceId!)).toBeNull();
    const mark = logMark();

    const states = recordJoinStates(bobDesktop, conv.id);
    await bobDesktop.client.instance.refresh();
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    await waitJoined(bobDesktop, conv.id, 30_000);
    expect(states).toEqual(["joining", "joined"]);
    expect(bobDesktop.client.conversations.get(conv.id)?.memberAccountIds.sort()).toEqual([aliceId, bobId].sort());

    // The join commit's sender is the desktop; no welcome followed it; its leaf is active at the new epoch.
    const commits = await commitsOf(conv.id);
    expect(commits).toHaveLength(2);
    expect(commits[0].senderInstanceId).toBe(alice.client.instanceId); // the initial add of the phone
    expect(commits[1]).toMatchObject({ senderInstanceId: bobDesktop.client.instanceId, epoch: epochBefore });
    expect(await welcomesOf(conv.id)).toHaveLength(1); // the phone's, from the initial commit
    expect((await welcomesOf(conv.id))[0].seq).toBeLessThan(commits[1].seq);
    expect((await conversationRow(conv.id)).currentEpoch).toBe(epochBefore + 1);
    expect(await leafRow(conv.id, bobDesktop.client.instanceId!)).toMatchObject({ state: "active", addedEpoch: epochBefore + 1, removedEpoch: null });
    expect((await leavesOf(conv.id)).filter((l) => l.accountId === bobId && l.state === "active")).toHaveLength(2);
    expect(await expectRealGroupInfo(conv.id)).toMatchObject({ epoch: epochBefore + 1, signerInstanceId: bobDesktop.client.instanceId });
    expect(await recipientsOf(commits[1].id)).toEqual([alice.client.instanceId, bobIos.client.instanceId].sort());
    expect(conflictsSince(mark)).toEqual([]);

    // Alice was online: she admits the desktop (approved by the phone, so in Bob's chain) and her next
    // message decrypts there through MLS. `before` may be there too, but only by one route: the phone,
    // in the reconcile right after approving, queued an add for the desktop and offered it history
    // (`autoOffer`) before it was stopped, and the desktop accepted that offer once active. The add
    // itself never landed (two commits, above); the offer row is the proof of the route.
    await waitFor(() => alice.client.conversations.get(conv.id)?.epoch === epochBefore + 1, 20_000);
    const after = h.unique("after desktop");
    await alice.client.messages.send(conv.id, after);
    await waitForText(bobDesktop, conv.id, after, 20_000);
    const onDesktop = texts(bobDesktop.client.messages.timeline(conv.id));
    expect(onDesktop[onDesktop.length - 1]).toBe(after);
    expect(onDesktop.every((t) => t === before || t === after)).toBe(true);
    if (onDesktop.includes(before)) {
      const offers = await h.db.select().from(schema.historyOffers).where(eq(schema.historyOffers.recipientInstanceId, bobDesktop.client.instanceId!));
      expect(offers.map((o) => o.donorInstanceId)).toEqual([bobIos.client.instanceId]);
    }
    const fromDesktop = h.unique("from desktop");
    await bobDesktop.client.messages.send(conv.id, fromDesktop);
    await waitForText(alice, conv.id, fromDesktop);

    // The phone returns, follows the desktop's commit, and reads the desktop's message as its own account's.
    const bobIos2 = await h.makeClient(bobId, "Bob iOS", "ios", { storage: bobIos.storage, secrets: bobIos.secrets });
    await waitFor(() => bobIos2.client.conversations.get(conv.id)?.epoch === epochBefore + 1, 20_000);
    await waitForText(bobIos2, conv.id, fromDesktop, 20_000);
    expect(bobIos2.client.messages.timeline(conv.id).find((i) => i.content.kind === "text" && i.content.body === fromDesktop)?.isOwn).toBe(true);
    await bobIos2.client.sync.now();
    expect(await commitsOf(conv.id)).toHaveLength(2); // the elector never added the desktop
    await stopAll(alice, bobIos2, bobDesktop);
  }, 120_000);

  it("(3) resync: the group state wiped, the instance kept: one commit by the same instance replaces its own leaf (same row), members unchanged, traffic resumes both ways", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    const bob = await h.makeClient(bobId, "Bob", "ios");
    const conv = await alice.client.conversations.createDirect(bobId);
    await waitJoined(bob, conv.id);
    const one = h.unique("one");
    await alice.client.messages.send(conv.id, one);
    await waitForText(bob, conv.id, one);
    const two = h.unique("two");
    await bob.client.messages.send(conv.id, two);
    await waitForText(alice, conv.id, two);
    const bobInstanceId = bob.client.instanceId!;
    const leafBefore = await leafRow(conv.id, bobInstanceId);
    expect(leafBefore).toMatchObject({ state: "active", addedEpoch: 1 });
    const epochBefore = (await conversationRow(conv.id)).currentEpoch;
    const commitsBefore = (await commitsOf(conv.id)).length;
    await bob.client.stop();

    // Only the group state goes. Every key the SDK writes is
    // `allo/<appId>/<accountId>/<instanceId>/<kind>/<id>` (core `storage/namespace.ts`); the record,
    // the timeline and the signing key stay.
    const groupStatePrefix = `allo/allo/${bobId}/${bobInstanceId}/groupState/`;
    const wiped = [...bob.storage.map.keys()].filter((k) => k.startsWith(groupStatePrefix));
    expect(wiped).toEqual([`${groupStatePrefix}${conv.id}`]);
    for (const key of wiped) bob.storage.map.delete(key);
    expect(bob.storage.map.has(`allo/allo/${bobId}/${bobInstanceId}/conversation/${conv.id}`)).toBe(true);
    const mark = logMark();

    const bob2 = await h.makeClient(bobId, "Bob", "ios", { start: false, storage: bob.storage, secrets: bob.secrets });
    const states = recordJoinStates(bob2, conv.id);
    await bob2.client.start();
    expect(bob2.client.instanceId).toBe(bobInstanceId);
    expect(texts(bob2.client.messages.timeline(conv.id))).toEqual([one, two]); // history kept
    await waitJoined(bob2, conv.id, 30_000);
    expect(states).toEqual(["joining", "joined"]);

    // One resync commit, by the same instance, at the epoch it lost; the leaf ROW is the same one,
    // re-added at the new epoch; still exactly two leaves, both active; no welcome.
    const commits = await commitsOf(conv.id);
    expect(commits).toHaveLength(commitsBefore + 1);
    const resync = commits[commits.length - 1];
    expect(resync).toMatchObject({ senderInstanceId: bobInstanceId, epoch: epochBefore });
    expect(await welcomesOf(conv.id)).toHaveLength(1);
    expect((await conversationRow(conv.id)).currentEpoch).toBe(epochBefore + 1);
    expect(await leafRow(conv.id, bobInstanceId)).toMatchObject({ id: leafBefore!.id, state: "active", addedEpoch: epochBefore + 1, removedEpoch: null });
    expect((await leavesOf(conv.id)).map((l) => [l.instanceId, l.state]).sort()).toEqual([[alice.client.instanceId, "active"], [bobInstanceId, "active"]].sort());
    expect(await expectRealGroupInfo(conv.id)).toMatchObject({ epoch: epochBefore + 1, signerInstanceId: bobInstanceId });
    expect(await recipientsOf(resync.id)).toEqual([alice.client.instanceId]);
    expect((await memberRows(conv.id)).map((m) => [m.accountId, m.state]).sort()).toEqual([[aliceId, "joined"], [bobId, "joined"]].sort());
    expect(conflictsSince(mark)).toEqual([]);

    // Alice follows it (her tree still holds two leaves) and traffic resumes both ways.
    await waitFor(() => alice.client.conversations.get(conv.id)?.epoch === epochBefore + 1, 20_000);
    expect(alice.client.conversations.get(conv.id)?.memberAccountIds.sort()).toEqual([aliceId, bobId].sort());
    expect(alice.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([]);
    const three = h.unique("three");
    await alice.client.messages.send(conv.id, three);
    await waitForText(bob2, conv.id, three, 20_000);
    const four = h.unique("four");
    await bob2.client.messages.send(conv.id, four);
    await waitForText(alice, conv.id, four);
    expect(texts(bob2.client.messages.timeline(conv.id))).toEqual([one, two, three, four]);
    await stopAll(alice, bob2);
  }, 120_000);

  it("(4) a forged joiner: an active instance planted on Bob's account outside his chain is accepted by the server and refused by both members; it never reads a message, and Alice's later send is measured", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    const bob = await h.makeClient(bobId, "Bob", "ios");
    const conv = await alice.client.conversations.createDirect(bobId);
    await waitJoined(bob, conv.id);
    const earlier = h.unique("before the forgery");
    await alice.client.messages.send(conv.id, earlier);
    await waitForText(bob, conv.id, earlier);
    const epochBefore = (await conversationRow(conv.id)).currentEpoch;
    const seqBefore = (await conversationRow(conv.id)).lastSeq;

    // Somebody with Bob's Oxy session (or the database) plants a second "bootstrap root": an `active`
    // row nobody approved. The registration API would keep it `pending`, so it goes straight into the table.
    const key = generateSigningKey();
    const plantedId = `planted-${randomUUID()}`;
    await h.db.insert(schema.clientInstances).values({
      id: plantedId,
      accountId: bobId,
      appId: "allo",
      platform: "android",
      displayName: "planted",
      signingPublicKey: Buffer.from(key.publicKey).toString("base64"),
      status: "active",
      enrolledAt: new Date(),
    });
    // The signed surface takes it as any instance: real key packages for it go up, and the GroupInfo
    // — readable by any joined member row — comes down.
    const e = await CryptoEngine.create();
    const forged = e.createIdentity({ accountId: bobId, instanceId: plantedId, signingKey: key });
    const bundles = await e.generateKeyPackages(forged, 2);
    const uploaded = await signedFetch(bobId, plantedId, key, "PUT", "/v1/key-packages", {
      keyPackages: bundles.map((b) => ({ ciphersuite: 1, ref: base64Encode(keyPackageRefFromWire(b.publicWire)), data: base64Encode(b.publicWire) })),
    });
    expect(uploaded.status).toBe(200);
    const gi = await signedFetch(bobId, plantedId, key, "GET", `/v1/conversations/${conv.id}/group-info`);
    expect(gi.status).toBe(200);
    const stored = gi.body!.groupInfo as { epoch: number; data: string; signerInstanceId: string };
    expect(stored).toMatchObject({ epoch: epochBefore, signerInstanceId: alice.client.instanceId });

    // A perfectly valid external commit for it, posted the way the SDK would.
    const join = await e.joinExternal(forged, base64Decode(stored.data), { resync: false });
    expect(join.epoch).toBe(epochBefore);
    const request: SubmitEventRequest = {
      idempotencyKey: `forged-${randomUUID()}`,
      kind: "mls_commit",
      epoch: join.epoch,
      payload: base64Encode(join.commit),
      commit: { newEpoch: join.epoch + 1, kind: "external", addedLeaves: [{ accountId: bobId, instanceId: plantedId }], removedLeaves: [], groupInfo: base64Encode(join.groupInfo) },
    };
    const mark = logMark();
    const posted = await signedFetch(bobId, plantedId, key, "POST", `/v1/conversations/${conv.id}/events`, request);
    expect(posted.status).toBe(200); // the server cannot tell: a joined member row is all it checks
    const forgedSeq = (posted.body!.event as { seq: number }).seq;
    expect((await conversationRow(conv.id)).currentEpoch).toBe(epochBefore + 1);
    expect(await leafRow(conv.id, plantedId)).toMatchObject({ state: "active", addedEpoch: epochBefore + 1 });
    expect(await groupInfoRow(conv.id)).toMatchObject({ epoch: epochBefore + 1, signerInstanceId: plantedId });
    const forgedEvent = (await commitsOf(conv.id)).find((c) => c.senderInstanceId === plantedId)!;
    expect(await recipientsOf(forgedEvent.id)).toEqual([alice.client.instanceId, bob.client.instanceId].sort());

    // Both members are nudged, pull the commit, and refuse it: the joiner's credential names an instance
    // that is not in Bob's verified chain (a second unapproved instance). Their state is untouched.
    await alice.client.sync.now();
    await bob.client.sync.now();
    await sleep(200);
    for (const c of [alice, bob]) {
      const view = c.client.conversations.get(conv.id)!;
      expect(view.joined).toBe(true);
      expect(view.joinState).toBe("joined");
      expect(view.epoch).toBe(epochBefore);
      expect(view.memberAccountIds.sort()).toEqual([aliceId, bobId].sort());
    }

    // An honest sender now that the server sits at an epoch it refused: Alice encrypts at
    // `epochBefore`, the server answers 409 `epoch_conflict`, the outbox re-syncs, sees that the
    // local epoch cannot advance (the commit was refused), and after EPOCH_STALL_LIMIT (3) such
    // conflicts holds the item with backoff instead of looping. Before the cap this measured 128
    // refused POSTs in 1.5 s. The conversation is marked `refused_commit` for its honest members:
    // fail closed, surfaced, bounded.
    const later = h.unique("after the forgery");
    const laterKey = await alice.client.messages.send(conv.id, later);
    await sleep(1500);
    const item = alice.client.messages.timeline(conv.id).find((i) => i.localKey === laterKey);
    const conflicts = conflictsSince(mark).filter((r) => r.method === "POST" && r.route.endsWith("/events"));
    expect(item?.sendState).toBe("pending");
    expect(item?.seq ?? null).toBeNull();
    expect(item?.holdReason).toBe("epoch_stalled"); // held, not retried forever
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    // Three conflicts reach the cap, then the item is held and retried under a
    // growing backoff (1 s, 2 s, 4 s…), so a 1.5 s window sees at most one more.
    // Before the cap this window measured 128. The exact cap is pinned by core's
    // own test (i1) on the fake server; here the property is "bounded and slowing".
    expect(conflicts.length).toBeLessThanOrEqual(5);
    expect(alice.client.conversations.get(conv.id)?.epoch).toBe(epochBefore); // she did not adopt the forged epoch to get through
    expect(alice.client.conversations.get(conv.id)?.integrity).toBe("refused_commit");
    expect(bob.client.conversations.get(conv.id)?.integrity).toBe("refused_commit");
    await alice.client.stop(); // nothing below needs her online
    const conflictsAtStop = conflictsSince(mark).filter((r) => r.method === "POST" && r.route.endsWith("/events")).length;

    // The security property. Nothing of Alice's landed after the forgery, so there is nothing for the
    // planted device to read; and it cannot read what came before either, an external joiner holds no
    // earlier epoch's keys. Every app_message on the server is tried against its state.
    const events = await eventsOf(conv.id);
    expect(events.filter((ev) => ev.seq > forgedSeq && ev.senderInstanceId === alice.client.instanceId)).toEqual([]);
    expect(events.filter((ev) => ev.seq > forgedSeq && ev.kind === "app_message")).toEqual([]);
    expect(texts(bob.client.messages.timeline(conv.id))).toEqual([earlier]);
    const appMessages = events.filter((ev) => ev.kind === "app_message");
    expect(appMessages.length).toBeGreaterThanOrEqual(1); // `earlier` and Bob's receipt
    for (const ev of appMessages) {
      await expect(e.processIncoming(join.next, new Uint8Array(ev.payload)), `planted device decrypts event ${ev.seq}`).rejects.toThrow();
    }
    const toPlanted = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.instanceId, plantedId));
    expect(toPlanted).toEqual([]); // nothing was ever addressed to it
    expect((await memberRows(conv.id)).map((m) => [m.accountId, m.state]).sort()).toEqual([[aliceId, "joined"], [bobId, "joined"]].sort());
    expect(forgedSeq).toBeGreaterThan(seqBefore); // after `earlier` (and Bob's receipt for it, which may land between)
    expect(conflictsAtStop).toBeGreaterThanOrEqual(conflicts.length);
    await stopAll(bob);
  }, 120_000);

  it("(5) a conversation from before GroupInfo existed: Bob's device waits for a member, Alice's elector adds him with a Welcome, and her Add leaves the GroupInfo behind", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    await waitFor(() => alice.client.sync.state() === "live");
    const conv = await alice.client.conversations.createDirect(bobId);
    expect(await groupInfoRow(conv.id)).toMatchObject({ epoch: 0 });
    // As if the conversation predated the field. (A raw-API create without a PUT would leave Alice's
    // SDK with no MLS state for the conversation, and then nobody could be its elector; deleting the
    // row is the same server state with a real elector online.)
    await h.db.delete(schema.conversationGroupInfo).where(eq(schema.conversationGroupInfo.conversationId, conv.id));
    expect(await groupInfoRow(conv.id)).toBeNull();
    const mark = logMark();

    // Bob installs, asks, finds nothing, and says so. The registration nudges Alice's leaf; her elector
    // adds him once his key packages are up.
    const bob = await h.makeClient(bobId, "Bob", "ios", { start: false });
    const states = recordJoinStates(bob, conv.id);
    await bob.client.start();
    await waitFor(() => states.includes("waiting_for_member"), 20_000);
    await waitJoined(bob, conv.id, 40_000);
    expect(states).toEqual(["joining", "waiting_for_member", "joined"]);
    const gets = requestLog(mark).filter((r) => r.method === "GET" && r.route.endsWith("/group-info"));
    expect(gets.length).toBeGreaterThanOrEqual(1);
    expect(gets.every((r) => r.status === 200)).toBe(true);

    // Alice's Add, with a Welcome, is the only commit; Bob posted none; the Add carried the GroupInfo of epoch 1.
    const commits = await commitsOf(conv.id);
    expect(commits).toHaveLength(1);
    expect(commits[0]).toMatchObject({ senderInstanceId: alice.client.instanceId, epoch: 0 });
    expect(await welcomesOf(conv.id)).toHaveLength(1);
    expect(await leafRow(conv.id, bob.client.instanceId!)).toMatchObject({ state: "active", addedEpoch: 1 });
    expect(await expectRealGroupInfo(conv.id)).toMatchObject({ epoch: 1, signerInstanceId: alice.client.instanceId });
    expect(conflictsSince(mark).length).toBeLessThanOrEqual(1); // the elector and a joiner that found nothing cannot race; tolerated as in reach

    const hello = h.unique("hello");
    await alice.client.messages.send(conv.id, hello);
    await waitForText(bob, conv.id, hello);
    const back = h.unique("hello back");
    await bob.client.messages.send(conv.id, back);
    await waitForText(alice, conv.id, back);
    await stopAll(alice, bob);
  }, 120_000);

  it("the server held ciphertext only", async () => {
    expect(h.sent.length).toBeGreaterThan(0);
    const payloads = await h.allPayloads();
    for (const text of h.sent) {
      const needle = Buffer.from(text, "utf8");
      expect(payloads.some((p) => p.includes(needle)), `plaintext "${text}" in a stored payload`).toBe(false);
    }
    // Control: the search finds a planted copy.
    expect([...payloads, Buffer.from(`>${h.sent[0]}<`)].some((p) => p.includes(Buffer.from(h.sent[0]))), "control").toBe(true);
  });
});
