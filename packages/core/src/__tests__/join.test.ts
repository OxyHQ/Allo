/**
 * Self-join by MLS external commit (RFC 9420 §12.4.3.2) and lost-state resync.
 *
 * A device that is a member with no active leaf joins the conversation by
 * itself from the GroupInfo the server stores with every commit; a device that
 * lost its group state but kept its signing key replaces its own leaf the same
 * way. Nobody else needs to be online. The elector rules (`reach.test.ts`)
 * are the fallback for a conversation whose commits predate the field.
 *
 * The engine tests at the end are the mutation checks: remove the joiner
 * validation and a forged joiner is accepted; remove the "exactly self" rule on
 * the fake server and a commit adding somebody else goes through.
 */
import { describe, expect, it } from "vitest";
import { submitEventRequestSchema, type SubmitEventRequest } from "@allo/shared-types";
import { fakeServer, flush, makeClient, stopAll, texts, waitFor, waitForText, waitJoined, type TestClient } from "./e2eHelpers";
import { engine, identity } from "./helpers";
import { AtRestCipher } from "../crypto/atRest";
import { generateSigningKey, publicKeyBase64, signRequest, signingKeyFromSecret, type SigningKeyPair } from "../crypto/signing";
import { JoinRefusedError, InvalidStateError } from "../errors";
import { AlloStore } from "../storage/store";
import { Namespace } from "../storage/namespace";
import { MemorySecrets, MemoryStorage } from "../testing/memoryAdapters";
import type { FakeAlloServer } from "../testing/fakeServer";
import { base64Decode, base64Encode, randomBytes, sha256Hex, utf8Encode } from "../util/bytes";
import { sleep } from "../util/async";
import type { JoinerAdmission } from "../crypto/engine";

const ALICE = "acc-alice-01";
const BOB = "acc-bob-0001";
const CAROL = "acc-carol-01";

const commitsBy = (server: FakeAlloServer, conversationId: string, instanceId: string | null) =>
  server.eventsOf(conversationId).filter((e) => e.kind === "mls_commit" && e.senderInstanceId === instanceId);
const leavesOf = (server: FakeAlloServer, conversationId: string, accountId: string) =>
  [...server.conversations.get(conversationId)!.leaves.entries()].filter(([, l]) => l.accountId === accountId && l.state === "active");

/** The instance store of a stopped client, to damage exactly one record. */
async function storeOf(c: TestClient) {
  const cipher = await AtRestCipher.open(c.secrets, c.accountId, "allo");
  return new AlloStore(c.storage, cipher, new Namespace("allo", c.accountId)).forInstance(c.client.instanceId!);
}

/** A signed request straight at the fake server from an arbitrary key, for what the SDK refuses to do on its own. */
async function signedFetch(server: FakeAlloServer, accountId: string, instanceId: string, key: SigningKeyPair, method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const timestampMs = Date.now();
  const sig = signRequest(key, { method, pathWithQuery: path, timestampMs, bodySha256Hex: sha256Hex(utf8Encode(text ?? "")) });
  return server.fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer fake-token:${accountId}`,
      "x-allo-instance": instanceId,
      "x-allo-timestamp": String(timestampMs),
      "x-allo-signature": sig,
      ...(text ? { "content-type": "application/json" } : {}),
    },
    body: text,
  });
}

describe("self-join by external commit", () => {
  it("(j1) Alice's DM with a not-yet-installed Bob, Alice offline: Bob joins himself; Alice processes the commit on restart; messages both ways", async () => {
    const server = fakeServer();
    const storage = new MemoryStorage();
    const secrets = new MemorySecrets();
    const alice1 = await makeClient(server, ALICE, "Alice", "web", { storage, secrets });
    const conv = await alice1.client.conversations.createDirect(BOB);
    expect(conv.joined).toBe(true);
    expect(conv.joinState).toBe("joined");
    // no initial commit (nobody to add), so the creator published the epoch-0 GroupInfo itself
    expect(server.eventsOf(conv.id).filter((e) => e.kind === "mls_commit")).toHaveLength(0);
    expect(server.groupInfos.get(conv.id)?.epoch).toBe(0);
    expect(server.groupInfos.get(conv.id)?.signerInstanceId).toBe(alice1.client.instanceId);
    const held = await alice1.client.messages.send(conv.id, "while you were out");
    await alice1.client.sync.flush();
    await alice1.client.stop();

    // Bob installs: nobody is online to add him. He finds the GroupInfo and joins by himself.
    const bob = await makeClient(server, BOB, "Bob", "ios");
    await waitJoined(bob, conv.id, 10_000);
    expect(bob.client.conversations.get(conv.id)?.joinState).toBe("joined");
    expect(commitsBy(server, conv.id, bob.client.instanceId)).toHaveLength(1);
    expect(commitsBy(server, conv.id, alice1.client.instanceId)).toHaveLength(0);
    expect(server.conversations.get(conv.id)!.epoch).toBe(1);
    expect(leavesOf(server, conv.id, BOB)).toHaveLength(1);
    expect(server.conversations.get(conv.id)!.leaves.get(bob.client.instanceId!)?.addedEpoch).toBe(1);
    // the joiner's commit stored the GroupInfo of the epoch it created, signed by the joiner (spike 3f)
    expect(server.groupInfos.get(conv.id)).toMatchObject({ epoch: 1, signerInstanceId: bob.client.instanceId });
    // the commit was delivered to Alice's leaf and to nobody else (the joiner authored it)
    const commit = commitsBy(server, conv.id, bob.client.instanceId)[0];
    expect(server.deliveries.filter((d) => d.event.id === commit.id).map((d) => d.instanceId)).toEqual([alice1.client.instanceId]);
    expect(bob.client.conversations.get(conv.id)?.memberAccountIds.sort()).toEqual([ALICE, BOB]);

    // Alice restarts, processes the external commit (Bob's instance is his account's bootstrap root), and the held message goes out.
    const alice2 = await makeClient(server, ALICE, "Alice", "web", { storage, secrets });
    await waitFor(() => alice2.client.conversations.get(conv.id)?.epoch === 1, 10_000);
    expect(alice2.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([]);
    await waitForText(bob, conv.id, "while you were out", 10_000);
    expect(alice2.client.messages.timeline(conv.id).find((i) => i.localKey === held)?.holdReason).toBeUndefined();
    await bob.client.messages.send(conv.id, "hi alice");
    await waitForText(alice2, conv.id, "hi alice");
    await alice2.client.messages.send(conv.id, "hi bob");
    await waitForText(bob, conv.id, "hi bob");
    expect(server.requestLog.some((r) => r.status === 409)).toBe(false);
    await stopAll(alice2, bob);
  });

  it("(j2) Bob's second device joins itself with nobody else online, and the first device offers it history once it sees the leaf", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");
    const bobIos = await makeClient(server, BOB, "Bob iOS", "ios");
    const conv = await alice.client.conversations.createDirect(BOB);
    await waitJoined(bobIos, conv.id);
    await alice.client.messages.send(conv.id, "before desktop");
    await waitForText(bobIos, conv.id, "before desktop");
    await alice.client.stop();

    const bobDesktop = await makeClient(server, BOB, "Bob desktop", "desktop");
    expect(bobDesktop.client.instance.state()).toBe("pending-approval");
    await bobIos.client.instance.refreshPending();
    await bobIos.client.instance.approve(bobDesktop.client.instanceId!);
    // Bob-ios goes away before the desktop has anything it could be added with.
    await bobIos.client.stop();
    expect(leavesOf(server, conv.id, BOB)).toHaveLength(1);

    await bobDesktop.client.instance.refresh();
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    await waitJoined(bobDesktop, conv.id, 10_000);
    expect(commitsBy(server, conv.id, bobDesktop.client.instanceId)).toHaveLength(1);
    expect(commitsBy(server, conv.id, bobIos.client.instanceId)).toHaveLength(0);
    expect(leavesOf(server, conv.id, BOB)).toHaveLength(2);
    expect(bobDesktop.client.conversations.get(conv.id)?.memberAccountIds.sort()).toEqual([ALICE, BOB]);

    // Everybody returns. Bob-ios processes the external commit (the desktop is in its own chain) and, being the
    // account's elector, offers the desktop its history; Alice reads the desktop's message.
    const alice2 = await makeClient(server, ALICE, "Alice", "web", { storage: alice.storage, secrets: alice.secrets });
    const bobIos2 = await makeClient(server, BOB, "Bob iOS", "ios", { storage: bobIos.storage, secrets: bobIos.secrets });
    await waitFor(() => bobIos2.client.conversations.get(conv.id)?.epoch === 2, 10_000);
    await waitForText(bobDesktop, conv.id, "before desktop", 15_000);
    await bobDesktop.client.messages.send(conv.id, "from desktop");
    await waitForText(alice2, conv.id, "from desktop", 10_000);
    await waitForText(bobIos2, conv.id, "from desktop", 10_000);
    expect(bobIos2.client.messages.timeline(conv.id).find((i) => i.content.kind === "text" && i.content.body === "from desktop")?.isOwn).toBe(true);
    // the elector never added the desktop: the external commit is the only one after the initial add
    expect(server.eventsOf(conv.id).filter((e) => e.kind === "mls_commit")).toHaveLength(2);
    await stopAll(alice2, bobIos2, bobDesktop);
  });

  it("(j3) resync: the group state wiped, the instance kept: one commit by the same instance, members unchanged, traffic resumes", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");
    const bob = await makeClient(server, BOB, "Bob", "ios");
    const conv = await alice.client.conversations.createDirect(BOB);
    await waitJoined(bob, conv.id);
    await alice.client.messages.send(conv.id, "one");
    await waitForText(bob, conv.id, "one");
    await bob.client.messages.send(conv.id, "two");
    await waitForText(alice, conv.id, "two");
    const bobId = bob.client.instanceId!;
    const epochBefore = alice.client.conversations.get(conv.id)!.epoch;
    await bob.client.stop();

    // Only the group state goes; the record, the timeline and the signing key stay.
    const store = await storeOf(bob);
    expect(await store.getBytes("groupState", conv.id)).toBeDefined();
    await store.delete("groupState", conv.id);

    const bob2 = await makeClient(server, BOB, "Bob", "ios", { storage: bob.storage, secrets: bob.secrets });
    expect(bob2.client.instanceId).toBe(bobId);
    expect(texts(bob2.client.messages.timeline(conv.id))).toEqual(["one", "two"]); // history kept
    await waitJoined(bob2, conv.id, 10_000);
    const resyncs = commitsBy(server, conv.id, bobId).filter((e) => e.epoch === epochBefore);
    expect(resyncs).toHaveLength(1);
    expect(server.conversations.get(conv.id)!.epoch).toBe(epochBefore + 1);
    // members unchanged: one leaf per instance, on the server and in every tree
    expect(server.conversations.get(conv.id)!.leaves.size).toBe(2);
    expect(server.conversations.get(conv.id)!.leaves.get(bobId)).toMatchObject({ state: "active", addedEpoch: epochBefore + 1 });
    await waitFor(() => alice.client.conversations.get(conv.id)?.epoch === epochBefore + 1, 10_000);
    expect(alice.client.conversations.get(conv.id)?.memberAccountIds.sort()).toEqual([ALICE, BOB]);
    expect(alice.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([]);
    await alice.client.messages.send(conv.id, "three");
    await waitForText(bob2, conv.id, "three");
    await bob2.client.messages.send(conv.id, "four");
    await waitForText(alice, conv.id, "four");
    expect(texts(bob2.client.messages.timeline(conv.id))).toEqual(["one", "two", "three", "four"]);
    await stopAll(alice, bob2);
  });

  it("(j3b) resync: a group state that does not decode is skipped at load (the client still starts) and replaced the same way", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");
    const bob = await makeClient(server, BOB, "Bob", "ios");
    const conv = await alice.client.conversations.createDirect(BOB);
    await waitJoined(bob, conv.id);
    await bob.client.stop();
    const store = await storeOf(bob);
    await store.putBytes("groupState", conv.id, randomBytes(40));
    const bob2 = await makeClient(server, BOB, "Bob", "ios", { storage: bob.storage, secrets: bob.secrets });
    await waitJoined(bob2, conv.id, 10_000);
    expect(commitsBy(server, conv.id, bob.client.instanceId)).toHaveLength(1);
    await alice.client.messages.send(conv.id, "still here");
    await waitForText(bob2, conv.id, "still here");
    await stopAll(alice, bob2);
  });

  it("(j4) a forged joiner (an instance outside the account's chain) is accepted by the server but refused by every member; their state is untouched", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");
    const bob = await makeClient(server, BOB, "Bob", "ios");
    const conv = await alice.client.conversations.createDirect(BOB);
    await waitJoined(bob, conv.id);
    const epochBefore = alice.client.conversations.get(conv.id)!.epoch;
    // Somebody with Bob's Oxy session plants a second "bootstrap root" on his account: active on the server,
    // refused by the chain (a second unapproved instance). It reads the GroupInfo — any member row may — and
    // builds a perfectly valid external commit for it.
    const key = generateSigningKey();
    const planted = server.injectInstance({ accountId: BOB, signingPublicKey: publicKeyBase64(key), approvedByInstanceId: null });
    const gi = await signedFetch(server, BOB, planted.id, key, "GET", `/v1/conversations/${conv.id}/group-info`);
    expect(gi.status).toBe(200);
    const stored = (await gi.json()).groupInfo as { epoch: number; data: string };
    const e = await engine();
    const forged = e.createIdentity({ accountId: BOB, instanceId: planted.id, signingKey: key });
    const join = await e.joinExternal(forged, base64Decode(stored.data), { resync: false });
    const request: SubmitEventRequest = {
      idempotencyKey: "forged-join-1",
      kind: "mls_commit",
      epoch: join.epoch,
      payload: base64Encode(join.commit),
      commit: { newEpoch: join.epoch + 1, kind: "external", addedLeaves: [{ accountId: BOB, instanceId: planted.id }], removedLeaves: [], groupInfo: base64Encode(join.groupInfo) },
    };
    const res = await signedFetch(server, BOB, planted.id, key, "POST", `/v1/conversations/${conv.id}/events`, request);
    expect(res.status).toBe(200); // the server cannot tell: a joined member row is all it checks
    expect(server.conversations.get(conv.id)!.epoch).toBe(epochBefore + 1);

    // Both members receive the commit. Neither adopts it.
    await flush(alice, bob);
    await sleep(50);
    for (const c of [alice, bob]) {
      const view = c.client.conversations.get(conv.id)!;
      expect(view.epoch).toBe(epochBefore);
      expect(view.joined).toBe(true);
      expect(view.memberAccountIds.sort()).toEqual([ALICE, BOB]);
    }
    // The refused delivery is recorded as such, and the state's tree still holds exactly the two leaves.
    const aliceStore = await storeOf(alice);
    const events = await aliceStore.listJson("event", (await import("../storage/records")).eventRecordSchema);
    expect(events.map((r) => r.value).filter((r) => r.kind === "mls_commit" && r.senderInstanceId === planted.id).map((r) => r.failure)).toEqual(["joiner_refused"]);
    const state = e.deserializeGroup((await aliceStore.getBytes("groupState", conv.id))!);
    expect(e.membersOf(state).map((m) => m.instanceId).sort()).toEqual([alice.client.instanceId, bob.client.instanceId].sort());
    await stopAll(alice, bob);
  });

  it("(j5) two joiners racing at the same epoch: one epoch_conflict, both end up members, every tree agrees", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");
    const group = await alice.client.conversations.createGroup([BOB, CAROL]);
    expect(group.unreachableMemberAccountIds.sort()).toEqual([BOB, CAROL]);
    await alice.client.stop();
    // Bob's POST of his external commit is held until Carol has fetched the epoch-0 GroupInfo too, so both
    // build at epoch 0 whatever the scheduler does.
    let releaseBob: () => void = () => undefined;
    const bobMayPost = new Promise<void>((r) => (releaseBob = r));
    const gated: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? "GET") === "POST" && url.endsWith(`/v1/conversations/${group.id}/events`)) await bobMayPost;
      return server.fetch(input, init);
    };
    const bobStorage = new MemoryStorage();
    const bobSecrets = new MemorySecrets();
    const { createAlloClient } = await import("../client");
    const { FakeSession } = await import("../testing/memoryAdapters");
    const bobClient = createAlloClient({
      baseUrl: server.baseUrl,
      appId: "allo",
      platform: "ios",
      displayName: "Bob",
      session: FakeSession.for(BOB),
      storage: bobStorage,
      secrets: bobSecrets,
      transport: { fetch: gated, socketFactory: server.socketFactory },
      syncIntervalMs: 60_000,
      keyPackageTarget: 6,
    });
    const bobStarted = bobClient.start();
    const bob: TestClient = { client: bobClient, storage: bobStorage, secrets: bobSecrets, accountId: BOB, name: "Bob" };
    await waitFor(() => server.requestLog.some((r) => r.method === "GET" && r.path === `/v1/conversations/${group.id}/group-info` && r.instanceId !== null), 10_000);
    const carol = await makeClient(server, CAROL, "Carol", "android");
    await waitFor(() => server.requestLog.some((r) => r.method === "GET" && r.path === `/v1/conversations/${group.id}/group-info` && r.instanceId === carol.client.instanceId), 10_000);
    releaseBob();
    await bobStarted;
    await waitJoined(bob, group.id, 15_000);
    await waitJoined(carol, group.id, 15_000);
    expect(server.requestLog.filter((r) => r.status === 409 && r.path.endsWith("/events"))).toHaveLength(1);
    expect(server.conversations.get(group.id)!.epoch).toBe(2);
    expect(leavesOf(server, group.id, BOB)).toHaveLength(1);
    expect(leavesOf(server, group.id, CAROL)).toHaveLength(1);
    // the loser rebuilt from the winner's GroupInfo, so the second joiner's tree holds the first
    await flush(bob, carol);
    expect(bob.client.conversations.get(group.id)?.epoch).toBe(2);
    expect(carol.client.conversations.get(group.id)?.epoch).toBe(2);
    await bob.client.messages.send(group.id, "from bob");
    await waitForText(carol, group.id, "from bob", 10_000);
    await carol.client.messages.send(group.id, "from carol");
    await waitForText(bob, group.id, "from carol", 10_000);
    // Alice returns and follows both commits in order
    const alice2 = await makeClient(server, ALICE, "Alice", "web", { storage: alice.storage, secrets: alice.secrets });
    await waitForText(alice2, group.id, "from carol", 10_000);
    expect(alice2.client.conversations.get(group.id)?.unreachableMemberAccountIds).toEqual([]);
    await stopAll(alice2, bob, carol);
  });

  it("(j6) a conversation with no stored GroupInfo (old data): the device waits, the elector adds it, and the next commit leaves a GroupInfo behind", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");
    const conv = await alice.client.conversations.createDirect(BOB);
    expect(server.groupInfos.has(conv.id)).toBe(true);
    server.groupInfos.delete(conv.id); // as if the conversation predated the field
    const bob = await makeClient(server, BOB, "Bob", "ios");
    // Bob asked, found none, and says so; the server's nudge wakes Alice's elector, which adds him as before.
    await waitFor(() => server.requestLog.some((r) => r.method === "GET" && r.path === `/v1/conversations/${conv.id}/group-info` && r.instanceId === bob.client.instanceId));
    await waitFor(() => bob.client.conversations.get(conv.id)?.joinState === "waiting_for_member");
    await waitJoined(bob, conv.id, 15_000);
    expect(bob.client.conversations.get(conv.id)?.joinState).toBe("joined");
    expect(commitsBy(server, conv.id, alice.client.instanceId)).toHaveLength(1);
    expect(commitsBy(server, conv.id, bob.client.instanceId)).toHaveLength(0);
    expect(server.groupInfos.get(conv.id)).toMatchObject({ epoch: 1, signerInstanceId: alice.client.instanceId });
    await alice.client.messages.send(conv.id, "hello");
    await waitForText(bob, conv.id, "hello");
    await stopAll(alice, bob);
  });

  it("(j7) an old conversation is re-published once per session by a member, so a later device can join by itself", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");
    const bob = await makeClient(server, BOB, "Bob", "ios");
    const conv = await alice.client.conversations.createDirect(BOB);
    await waitJoined(bob, conv.id);
    await stopAll(alice, bob);
    server.groupInfos.delete(conv.id);
    server.requestLog.length = 0;
    // Bob restarts: his first reconcile finds the server holds nothing for epoch 1 and publishes his own.
    const bob2 = await makeClient(server, BOB, "Bob", "ios", { storage: bob.storage, secrets: bob.secrets });
    await waitFor(() => server.groupInfos.get(conv.id)?.epoch === 1);
    expect(server.groupInfos.get(conv.id)?.signerInstanceId).toBe(bob2.client.instanceId);
    const puts = () => server.requestLog.filter((r) => r.method === "PUT" && r.path.endsWith("/group-info"));
    expect(puts()).toHaveLength(1);
    await bob2.client.sync.now();
    await bob2.client.sync.now();
    expect(puts()).toHaveLength(1); // once per session
    expect(server.requestLog.filter((r) => r.method === "GET" && r.path.endsWith("/group-info"))).toHaveLength(1);
    // and Alice's new phone joins from it with Bob offline
    await bob2.client.stop();
    const alicePhone = await makeClient(server, ALICE, "Alice phone", "ios", { storage: new MemoryStorage(), secrets: new MemorySecrets() });
    expect(alicePhone.client.instance.state()).toBe("pending-approval");
    const aliceWeb = await makeClient(server, ALICE, "Alice", "web", { storage: alice.storage, secrets: alice.secrets });
    await aliceWeb.client.instance.refreshPending();
    await aliceWeb.client.instance.approve(alicePhone.client.instanceId!);
    await aliceWeb.client.stop();
    await alicePhone.client.instance.refresh();
    await waitJoined(alicePhone, conv.id, 10_000);
    expect(commitsBy(server, conv.id, alicePhone.client.instanceId)).toHaveLength(1);
    await stopAll(alicePhone);
  });

  it("(j8) the fake server's rules: an external commit must add exactly the sender, resync exactly replaces, GET needs a joined member, PUT needs an active leaf at the current epoch", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");
    const bob = await makeClient(server, BOB, "Bob", "ios");
    const conv = await alice.client.conversations.createDirect(BOB);
    await waitJoined(bob, conv.id);
    const stored = server.groupInfos.get(conv.id)!;
    const e = await engine();
    // Carol is nobody here: no member row, so the GroupInfo is not hers to read
    const carol = await makeClient(server, CAROL, "Carol", "android");
    const carolKey = signingKeyFromSecret((await carol.secrets.get(`allo.instance-key.${CAROL}.allo`))!);
    expect((await signedFetch(server, CAROL, carol.client.instanceId!, carolKey, "GET", `/v1/conversations/${conv.id}/group-info`)).status).toBe(404);
    // a planted, leafless instance of Bob's account may read it but its external commit must name ITSELF
    const key = generateSigningKey();
    const planted = server.injectInstance({ accountId: BOB, signingPublicKey: publicKeyBase64(key), approvedByInstanceId: null });
    const join = await e.joinExternal(e.createIdentity({ accountId: BOB, instanceId: planted.id, signingKey: key }), base64Decode(stored.data), { resync: false });
    const base = { kind: "mls_commit" as const, epoch: join.epoch, payload: base64Encode(join.commit) };
    const post = (idempotencyKey: string, commit: SubmitEventRequest["commit"]) =>
      signedFetch(server, BOB, planted.id, key, "POST", `/v1/conversations/${conv.id}/events`, { ...base, idempotencyKey, commit });
    const gi = base64Encode(join.groupInfo);
    // naming another leafless instance of the same account: nothing but the "exactly self" rule refuses it (the mutation check)
    const planted2 = server.injectInstance({ accountId: BOB, signingPublicKey: publicKeyBase64(generateSigningKey()), approvedByInstanceId: null });
    let res = await post("k1", { newEpoch: join.epoch + 1, kind: "external", addedLeaves: [{ accountId: BOB, instanceId: planted2.id }], removedLeaves: [], groupInfo: gi });
    expect(res.status).toBe(400);
    res = await post("k1b", { newEpoch: join.epoch + 1, kind: "external", addedLeaves: [{ accountId: BOB, instanceId: bob.client.instanceId! }], removedLeaves: [], groupInfo: gi });
    expect(res.status).toBe(400); // and an instance that already holds a leaf is refused on that ground too
    res = await post("k2", { newEpoch: join.epoch + 1, kind: "external", addedLeaves: [{ accountId: BOB, instanceId: planted.id }], removedLeaves: [bob.client.instanceId!], groupInfo: gi });
    expect(res.status).toBe(400); // the schema: an external commit removes nobody
    res = await post("k3", { newEpoch: join.epoch + 1, kind: "resync", addedLeaves: [{ accountId: BOB, instanceId: planted.id }], removedLeaves: [planted.id], groupInfo: gi });
    expect(res.status).toBe(403); // nothing to resync: it holds no leaf
    // the schema itself refuses a self-join with two added leaves or a welcome
    expect(submitEventRequestSchema.safeParse({ ...base, idempotencyKey: "k4", commit: { newEpoch: join.epoch + 1, kind: "external", addedLeaves: [{ accountId: BOB, instanceId: planted.id }, { accountId: BOB, instanceId: bob.client.instanceId }], removedLeaves: [], groupInfo: gi } }).success).toBe(false);
    expect(server.conversations.get(conv.id)!.epoch).toBe(join.epoch); // nothing landed
    // PUT: Carol has no leaf; Bob has, but only for the current epoch
    const bobKey = signingKeyFromSecret((await bob.secrets.get(`allo.instance-key.${BOB}.allo`))!);
    expect((await signedFetch(server, CAROL, carol.client.instanceId!, carolKey, "PUT", `/v1/conversations/${conv.id}/group-info`, { epoch: stored.epoch, data: stored.data })).status).toBe(404);
    res = await signedFetch(server, BOB, bob.client.instanceId!, bobKey, "PUT", `/v1/conversations/${conv.id}/group-info`, { epoch: stored.epoch + 1, data: stored.data });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "epoch_conflict", details: { currentEpoch: stored.epoch } });
    res = await signedFetch(server, BOB, bob.client.instanceId!, bobKey, "PUT", `/v1/conversations/${conv.id}/group-info`, { epoch: stored.epoch, data: stored.data });
    expect(res.status).toBe(204);
    expect(server.groupInfos.get(conv.id)?.signerInstanceId).toBe(bob.client.instanceId);
    // a member that left is told so on GET
    await bob.client.conversations.leave(conv.id);
    expect((await signedFetch(server, BOB, bob.client.instanceId!, bobKey, "GET", `/v1/conversations/${conv.id}/group-info`)).status).toBe(403);
    await stopAll(alice, bob, carol);
  });
});

describe("CryptoEngine: external join", () => {
  const admitting = (...trusted: Array<{ id: string; key: SigningKeyPair }>): JoinerAdmission => ({
    trustedInstancesOf: async () => trusted.map((t) => ({ id: t.id, signingPublicKey: publicKeyBase64(t.key) })),
  });

  it("publishes a GroupInfo every commit; a leafless device joins from it; the member admits a joiner in the chain and both read each other", async () => {
    const e = await engine();
    const alice = identity(e, "a");
    const bob = identity(e, "b");
    const aliceState = await e.createGroup(alice, randomBytes(16));
    const gi0 = await e.publishGroupInfo(aliceState);
    expect(e.peek(gi0).kind).toBe("group_info");
    const join = await e.joinExternal(bob, gi0, { resync: false });
    expect(join.epoch).toBe(0);
    expect(e.epochOf(join.next)).toBe(1);
    expect(e.membersOf(join.next).map((m) => m.accountId).sort()).toEqual(["a", "b"]);
    const joiner = e.externalJoinerOf(join.commit)!;
    expect(joiner).toMatchObject({ accountId: "b", instanceId: bob.instanceId, removedLeafIndexes: [] });
    // no admission policy → refused; the right one → processed
    await expect(e.processIncoming(aliceState, join.commit)).rejects.toBeInstanceOf(JoinRefusedError);
    const r = await e.processIncoming(aliceState, join.commit, admitting({ id: bob.instanceId, key: bob.signingKey }));
    expect(r.kind).toBe("commit");
    expect(r.removedSelf).toBe(false);
    expect(e.epochOf(r.next)).toBe(1);
    const toBob = await e.encryptApplication(r.next, utf8Encode("hi"));
    expect(new TextDecoder().decode((await e.processIncoming(join.next, toBob.ciphertext)).plaintext)).toBe("hi");
    const toAlice = await e.encryptApplication(join.next, utf8Encode("yo"));
    expect(new TextDecoder().decode((await e.processIncoming(toBob.next, toAlice.ciphertext)).plaintext)).toBe("yo");
    // the joiner's own GroupInfo admits the next joiner (spike 3f)
    const carol = identity(e, "c");
    const join2 = await e.joinExternal(carol, join.groupInfo, { resync: false });
    expect(e.epochOf(join2.next)).toBe(2);
    // an ordinary commit's GroupInfo describes the epoch it creates
    const [kp] = await e.generateKeyPackages(identity(e, "d"), 1);
    const c = await e.commit(r.next, { addKeyPackages: [kp.publicWire] });
    const join3 = await e.joinExternal(carol, c.groupInfo, { resync: false });
    expect(join3.epoch).toBe(2);
  });

  it("refuses a forged joiner: an instance not in the chain, or in the chain with another key; the state is untouched", async () => {
    const e = await engine();
    const alice = identity(e, "a");
    const bob = identity(e, "b");
    const aliceState = await e.createGroup(alice, randomBytes(16));
    const forged = identity(e, "b"); // claims to be Bob's account, an instance Bob's chain never approved
    const join = await e.joinExternal(forged, await e.publishGroupInfo(aliceState), { resync: false });
    await expect(e.processIncoming(aliceState, join.commit, admitting({ id: bob.instanceId, key: bob.signingKey }))).rejects.toThrow(/not in the verified chain/);
    // the right instance id but a key that is not the enrolled one
    await expect(e.processIncoming(aliceState, join.commit, admitting({ id: forged.instanceId, key: generateSigningKey() }))).rejects.toThrow(/not the one enrolled/);
    expect(e.epochOf(aliceState)).toBe(0);
    expect(e.membersOf(aliceState)).toHaveLength(1);
    // a credential that is not an Allo identity
    const anon = { ...forged, credential: { credentialType: "basic" as const, identity: utf8Encode("nobody") } };
    const join2 = await e.joinExternal(anon, await e.publishGroupInfo(aliceState), { resync: false });
    await expect(e.processIncoming(aliceState, join2.commit, admitting({ id: anon.instanceId, key: anon.signingKey }))).rejects.toThrow(/not an Allo identity/);
  });

  it("refuses a second leaf for a signing key or an instance already active, unless the same commit removes it (resync); refuses removing anybody else", async () => {
    const e = await engine();
    const alice = identity(e, "a");
    const bob = identity(e, "b");
    const admit = admitting({ id: bob.instanceId, key: bob.signingKey });
    const g = await e.createGroup(alice, randomBytes(16));
    const join = await e.joinExternal(bob, await e.publishGroupInfo(g), { resync: false });
    const aliceState = (await e.processIncoming(g, join.commit, admit)).next;
    const gi1 = await e.publishGroupInfo(aliceState);
    // the engine refuses to BUILD a duplicate join (spike gap 2: the library would accept it)...
    await expect(e.joinExternal(bob, gi1, { resync: false })).rejects.toBeInstanceOf(InvalidStateError);
    // ...and a member refuses one built elsewhere: the same key under a new instance id
    const twin = e.createIdentity({ accountId: "b", instanceId: "other-instance", signingKey: bob.signingKey });
    const dup = await e.joinExternal(twin, gi1, { resync: false }).catch((err) => err);
    expect(dup).toBeInstanceOf(InvalidStateError); // the guard reads the key, not the id
    // resync: one commit, remove + external_init, membership unchanged, admitted
    const resync = await e.joinExternal(bob, gi1, { resync: true });
    const joiner = e.externalJoinerOf(resync.commit)!;
    expect(joiner.removedLeafIndexes).toHaveLength(1);
    const r = await e.processIncoming(aliceState, resync.commit, admit);
    expect(e.membersOf(r.next).map((m) => m.accountId).sort()).toEqual(["a", "b"]);
    expect(e.membersOf(r.next)).toHaveLength(2);
    // resync with no former leaf is refused before anything is built
    await expect(e.joinExternal(identity(e, "c"), gi1, { resync: true })).rejects.toBeInstanceOf(InvalidStateError);
    // a removal naming somebody else's leaf is refused by the member even from an admitted instance
    const admitAll = admitting({ id: bob.instanceId, key: bob.signingKey }, { id: joiner.instanceId, key: bob.signingKey });
    const alienRemove = { ...joiner, removedLeafIndexes: [e.membersOf(aliceState).find((m) => m.accountId === "a")!.leafIndex] };
    await expect(e.admitJoiner(aliceState, alienRemove, admitAll)).rejects.toThrow(/own former leaf/);
    // and a plain join by an admitted instance whose id is already in the tree is refused (mutation: the uniqueness rule)
    const sameId = { ...joiner, removedLeafIndexes: [] };
    await expect(e.admitJoiner(aliceState, sameId, admitAll)).rejects.toThrow(/already holds an active leaf/);
  });

  it("gap 7.1: the old copy of a resynced state reports removedSelf and can neither send nor read what follows", async () => {
    const e = await engine();
    const alice = identity(e, "a");
    const bob = identity(e, "b");
    const admit = admitting({ id: bob.instanceId, key: bob.signingKey });
    const g = await e.createGroup(alice, randomBytes(16));
    const join = await e.joinExternal(bob, await e.publishGroupInfo(g), { resync: false });
    const aliceState = (await e.processIncoming(g, join.commit, admit)).next;
    const oldBob = join.next; // the copy that "was lost", still around somewhere
    const resync = await e.joinExternal(bob, await e.publishGroupInfo(aliceState), { resync: true });
    const seen = await e.processIncoming(oldBob, resync.commit, admit);
    expect(seen.kind).toBe("commit");
    expect(seen.removedSelf).toBe(true);
    expect(e.isActive(seen.next)).toBe(false);
    const aliceAfter = (await e.processIncoming(aliceState, resync.commit, admit)).next;
    const msg = await e.encryptApplication(aliceAfter, utf8Encode("only the new copy"));
    await expect(e.processIncoming(seen.next, msg.ciphertext)).rejects.toThrow();
    await expect(e.encryptApplication(seen.next, utf8Encode("x"))).rejects.toThrow();
    expect(new TextDecoder().decode((await e.processIncoming(resync.next, msg.ciphertext)).plaintext)).toBe("only the new copy");
  });
});
