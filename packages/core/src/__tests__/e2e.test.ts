import { describe, expect, it } from "vitest";
import { fakeServer, flush, makeClient, stopAll, texts, waitFor, waitForText, waitJoined } from "./e2eHelpers";
import { bytesEqual, bytesInclude, utf8Encode } from "../util/bytes";
import { sleep } from "../util/async";
import { MemorySecrets, MemoryStorage } from "../testing/memoryAdapters";

describe("end to end over the fake server", () => {
  it("(a) DM: text both ways, edit, delete, reaction, read receipt, rename", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    expect(alice.client.instance.state()).toBe("active");
    expect(bob.client.instance.state()).toBe("active");

    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    expect(conv.kind).toBe("dm");
    expect(conv.joined).toBe(true);
    await waitJoined(bob, conv.id);

    const aliceKey = await alice.client.messages.send(conv.id, "hi bob");
    const pendingEcho = alice.client.messages.timeline(conv.id).find((i) => i.localKey === aliceKey);
    expect(pendingEcho?.sendState).toBe("pending");
    const onBob = await waitForText(bob, conv.id, "hi bob");
    expect(onBob.isOwn).toBe(false);
    expect(onBob.senderAccountId).toBe("acc-alice-01");
    await waitFor(() => alice.client.messages.timeline(conv.id).find((i) => i.localKey === aliceKey)?.sendState === "accepted");
    const accepted = alice.client.messages.timeline(conv.id).find((i) => i.localKey === aliceKey)!;
    expect(accepted.id).toBe(onBob.id);
    expect(alice.client.messages.timeline(conv.id).filter((i) => i.content.kind === "text")).toHaveLength(1);

    await bob.client.messages.send(conv.id, "hi alice", { replyTo: onBob.id });
    const reply = await waitForText(alice, conv.id, "hi alice");
    expect(reply.replyTo).toBe(onBob.id);

    // no plaintext reached the server
    for (const e of server.eventsOf(conv.id)) {
      expect(bytesInclude(utf8Encode(e.payload), utf8Encode("hi bob"))).toBe(false);
    }

    await alice.client.messages.edit(conv.id, accepted.id, "hi bob (edited)");
    await waitForText(bob, conv.id, "hi bob (edited)");
    expect(bob.client.messages.timeline(conv.id).find((i) => i.id === accepted.id)?.content).toEqual({ kind: "text", body: "hi bob (edited)", isEdited: true });

    await bob.client.messages.react(conv.id, accepted.id, "👍");
    await waitFor(() => alice.client.messages.timeline(conv.id).find((i) => i.id === accepted.id)?.reactions.length === 1);
    expect(alice.client.messages.timeline(conv.id).find((i) => i.id === accepted.id)?.reactions).toEqual([{ key: "👍", accountIds: ["acc-bob-0001"] }]);
    await bob.client.messages.react(conv.id, accepted.id, "👍");
    await waitFor(() => alice.client.messages.timeline(conv.id).find((i) => i.id === accepted.id)?.reactions.length === 0);

    // read receipt: bob marks read → alice's message shows read
    expect(bob.client.conversations.get(conv.id)?.unreadCount).toBe(1);
    await bob.client.messages.markRead(conv.id);
    expect(bob.client.conversations.get(conv.id)?.unreadCount).toBe(0);
    await waitFor(() => alice.client.messages.timeline(conv.id).find((i) => i.id === accepted.id)?.sendState === "read");

    await alice.client.messages.remove(conv.id, accepted.id);
    await waitFor(() => bob.client.messages.timeline(conv.id).find((i) => i.id === accepted.id)?.content.kind === "deleted");

    await alice.client.conversations.rename(conv.id, "Us two");
    await waitFor(() => bob.client.conversations.get(conv.id)?.title === "Us two");
    expect(alice.client.conversations.get(conv.id)?.title).toBe("Us two");
    expect(alice.client.conversations.list().map((c) => c.id)).toEqual([conv.id]);

    await stopAll(alice, bob);
  });

  it("(b) second device: pending → approved by Bob-ios → added by the elector → sees Alice's next message; its message reaches Bob-ios", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bobIos = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bobIos, conv.id);
    await alice.client.messages.send(conv.id, "before desktop");
    await waitForText(bobIos, conv.id, "before desktop");

    const bobDesktop = await makeClient(server, "acc-bob-0001", "Bob desktop", "desktop");
    expect(bobDesktop.client.instance.state()).toBe("pending-approval");
    await bobIos.client.instance.refreshPending();
    const pending = bobIos.client.instance.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].instance.id).toBe(bobDesktop.client.instanceId);
    expect(pending[0].fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    // a wrong challenge is refused before anything is signed
    await expect(bobIos.client.instance.approve(pending[0].instance.id, "not-the-challenge")).rejects.toThrow(/challenge/);
    await bobIos.client.instance.approve(pending[0].instance.id, pending[0].challenge);
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    // desktop uploads key packages once active; then the elector (Bob-ios, lowest id) adds it
    await waitFor(() => (server.keyPackages.get(bobDesktop.client.instanceId!)?.length ?? 0) > 0);
    await bobIos.client.sync.now();
    await waitJoined(bobDesktop, conv.id, 10_000);
    expect(bobDesktop.client.messages.timeline(conv.id).filter((i) => i.content.kind === "text")).toHaveLength(0); // history before the join is not readable

    await alice.client.messages.send(conv.id, "after desktop");
    await waitForText(bobIos, conv.id, "after desktop");
    await waitForText(bobDesktop, conv.id, "after desktop");

    await bobDesktop.client.messages.send(conv.id, "from desktop");
    await waitForText(bobIos, conv.id, "from desktop");
    await waitForText(alice, conv.id, "from desktop");
    expect(bobIos.client.messages.timeline(conv.id).find((i) => i.content.kind === "text" && i.content.body === "from desktop")?.isOwn).toBe(true);
    expect(alice.client.conversations.get(conv.id)?.epoch).toBe(bobDesktop.client.conversations.get(conv.id)?.epoch);
    await stopAll(alice, bobIos, bobDesktop);
  });

  it("(c) offline catch-up: 20 messages while disconnected arrive in order after reconnect", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    server.setOffline(bob.client.instanceId!, true);
    await waitFor(() => bob.client.sync.state() !== "live");
    for (let i = 1; i <= 20; i++) await alice.client.messages.send(conv.id, `m${i}`);
    await alice.client.sync.flush();
    await sleep(50);
    expect(texts(bob.client.messages.timeline(conv.id))).toHaveLength(0);
    server.setOffline(bob.client.instanceId!, false);
    await waitFor(() => texts(bob.client.messages.timeline(conv.id)).length === 20, 10_000);
    expect(texts(bob.client.messages.timeline(conv.id))).toEqual(Array.from({ length: 20 }, (_, i) => `m${i + 1}`));
    await stopAll(alice, bob);
  });

  it("(d) revocation: the remaining leaf removes the revoked one; its state cannot read what follows", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bobIos = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bobIos, conv.id);
    const bobDesktop = await makeClient(server, "acc-bob-0001", "Bob desktop", "desktop");
    await bobIos.client.instance.refreshPending();
    await bobIos.client.instance.approve(bobDesktop.client.instanceId!);
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    await waitFor(() => (server.keyPackages.get(bobDesktop.client.instanceId!)?.length ?? 0) > 0);
    await bobIos.client.sync.now();
    await waitJoined(bobDesktop, conv.id, 10_000);
    await waitFor(() => alice.client.conversations.get(conv.id)!.epoch === bobDesktop.client.conversations.get(conv.id)!.epoch);
    const epochBefore = alice.client.conversations.get(conv.id)!.epoch;

    await bobDesktop.client.instance.revoke(bobIos.client.instanceId!);
    await waitFor(() => bobIos.client.instance.state() === "revoked");
    // desktop (the remaining leaf of the account) commits the Remove; alice processes it
    await waitFor(() => alice.client.conversations.get(conv.id)!.epoch === epochBefore + 1, 10_000);
    const leaves = server.conversations.get(conv.id)!.leaves;
    expect(leaves.get(bobIos.client.instanceId!)?.state).toBe("removed");

    await alice.client.messages.send(conv.id, "after revoke");
    await waitForText(bobDesktop, conv.id, "after revoke");
    // the revoked instance received nothing and its group state, even fed the ciphertext directly, cannot decrypt
    await sleep(50);
    expect(texts(bobIos.client.messages.timeline(conv.id))).not.toContain("after revoke");
    const ev = server.eventsOf(conv.id).filter((e) => e.kind === "app_message").pop()!;
    const { CryptoEngine } = await import("../crypto/engine");
    const { AtRestCipher } = await import("../crypto/atRest");
    const { AlloStore } = await import("../storage/store");
    const { Namespace } = await import("../storage/namespace");
    const { base64Decode } = await import("../util/bytes");
    const engine = await CryptoEngine.create();
    const cipher = await AtRestCipher.open(bobIos.secrets, "acc-bob-0001", "allo");
    const store = new AlloStore(bobIos.storage, cipher, new Namespace("allo", "acc-bob-0001")).forInstance(bobIos.client.instanceId!);
    const stateBytes = (await store.getBytes("groupState", conv.id))!;
    const state = engine.deserializeGroup(stateBytes);
    await expect(engine.processIncoming(state, base64Decode(ev.payload))).rejects.toThrow();
    await stopAll(alice, bobIos, bobDesktop);
  });

  it("(e) epoch conflict: two concurrent adds of Carol → one 409, resync, Carol added exactly once, all agree", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const carol = await makeClient(server, "acc-carol-01", "Carol", "android");
    const group = await alice.client.conversations.createGroup(["acc-bob-0001"]);
    await waitJoined(bob, group.id);
    await Promise.all([alice.client.conversations.addMember(group.id, "acc-carol-01"), bob.client.conversations.addMember(group.id, "acc-carol-01")]);
    await flush(alice, bob);
    await waitJoined(carol, group.id, 10_000);
    await flush(alice, bob, carol);
    expect(server.requestLog.some((r) => r.status === 409)).toBe(true);
    const carolLeaves = [...server.conversations.get(group.id)!.leaves.entries()].filter(([, l]) => l.accountId === "acc-carol-01");
    expect(carolLeaves).toHaveLength(1);
    expect(server.eventsOf(group.id).filter((e) => e.kind === "mls_commit")).toHaveLength(2); // initial add of bob, the winning carol add; the loser's retry found Carol present and was dropped
    const epochs = [alice, bob, carol].map((c) => c.client.conversations.get(group.id)!.epoch);
    expect(new Set(epochs).size).toBe(1);
    await alice.client.messages.send(group.id, "three of us");
    await waitForText(bob, group.id, "three of us");
    await waitForText(carol, group.id, "three of us");
    await stopAll(alice, bob, carol);
  });

  it("(f) restart: a client recreated on the same storage keeps its instance and timeline and can send", async () => {
    const server = fakeServer();
    const storage = new MemoryStorage();
    const secrets = new MemorySecrets();
    const alice1 = await makeClient(server, "acc-alice-01", "Alice", "web", { storage, secrets });
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice1.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    await alice1.client.messages.send(conv.id, "one");
    await bob.client.messages.send(conv.id, "two");
    await waitForText(alice1, conv.id, "two");
    const instanceId = alice1.client.instanceId;
    await alice1.client.stop();

    const alice2 = await makeClient(server, "acc-alice-01", "Alice", "web", { storage, secrets });
    expect(alice2.client.instanceId).toBe(instanceId);
    expect(alice2.client.instance.state()).toBe("active");
    expect(server.instancesOf("acc-alice-01")).toHaveLength(1);
    expect(texts(alice2.client.messages.timeline(conv.id))).toEqual(["one", "two"]);
    await alice2.client.messages.send(conv.id, "three");
    await waitForText(bob, conv.id, "three");
    await bob.client.messages.send(conv.id, "four");
    await waitForText(alice2, conv.id, "four");
    // secrets and storage never hold the plaintext or the raw signing key
    expect(bytesInclude(storage.dump(), utf8Encode("three"))).toBe(false);
    const rawKey = (await secrets.get(`allo.instance-key.acc-alice-01.allo`))!;
    expect(bytesInclude(storage.dump(), rawKey)).toBe(false);
    await stopAll(alice2, bob);
  });

  it("(g) media round trip", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    const bytes = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
    await alice.client.media.upload(conv.id, bytes, { kind: "file", filename: "data.bin", mime: "application/octet-stream", caption: "cap" });
    await waitFor(() => bob.client.messages.timeline(conv.id).some((i) => i.content.kind === "media"));
    const item = bob.client.messages.timeline(conv.id).find((i) => i.content.kind === "media")!;
    const media = (item.content as { media: { ref: { blobId: string; conversationId: string }; size: number; caption?: string } }).media;
    expect(media.size).toBe(5000);
    expect(media.caption).toBe("cap");
    const got = await bob.client.media.download(media.ref);
    expect(bytesEqual(got, bytes)).toBe(true);
    // the server holds ciphertext only
    const blob = server.blobs.get(media.ref.blobId)!;
    expect(bytesInclude(blob.bytes, bytes.subarray(0, 64))).toBe(false);
    await stopAll(alice, bob);
  });

  it("(g2) media download honours an AbortSignal", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    await alice.client.media.upload(conv.id, new Uint8Array(64), { kind: "file", filename: "a.bin", mime: "application/octet-stream" });
    await waitFor(() => bob.client.messages.timeline(conv.id).some((i) => i.content.kind === "media"));
    const media = (bob.client.messages.timeline(conv.id).find((i) => i.content.kind === "media")!.content as { media: { ref: { blobId: string; conversationId: string } } }).media;
    const controller = new AbortController();
    controller.abort();
    await expect(bob.client.media.download(media.ref, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect((await bob.client.media.download(media.ref)).length).toBe(64);
    await stopAll(alice, bob);
  });

  it("(h) a DM created twice returns the same conversation", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const a = await alice.client.conversations.createDirect("acc-bob-0001");
    const again = await alice.client.conversations.createDirect("acc-bob-0001");
    expect(again.id).toBe(a.id);
    await waitJoined(bob, a.id);
    const fromBob = await bob.client.conversations.createDirect("acc-alice-01");
    expect(fromBob.id).toBe(a.id);
    expect(server.conversations.size).toBe(1);
    expect(alice.client.conversations.list()).toHaveLength(1);
    await stopAll(alice, bob);
  });

  it("(i) planted instances with a forged or absent signature are skipped when adding; a valid chain of depth 3 is accepted", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bobIos = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    const { generateSigningKey, publicKeyBase64, signEnrollmentApproval } = await import("../crypto/signing");
    const rootId = bobIos.client.instanceId!;
    const root = server.instances.get(rootId)!;
    // (1) a second "bootstrap" root; (2) approved by the root but signed by somebody else; (3) no signature at all
    const plantedRoot = server.injectInstance({ accountId: "acc-bob-0001", signingPublicKey: publicKeyBase64(generateSigningKey()), approvedByInstanceId: null });
    const forgedKey = generateSigningKey();
    const forged = server.injectInstance({
      accountId: "acc-bob-0001",
      signingPublicKey: publicKeyBase64(forgedKey),
      approvedByInstanceId: rootId,
      approvalSignature: signEnrollmentApproval(generateSigningKey(), { accountId: "acc-bob-0001", newInstanceId: "x", newSigningPublicKey: publicKeyBase64(forgedKey), challenge: "Y2hhbGxlbmdl" }),
      enrollmentChallenge: "Y2hhbGxlbmdl",
    });
    const unsigned = server.injectInstance({ accountId: "acc-bob-0001", signingPublicKey: publicKeyBase64(generateSigningKey()), approvedByInstanceId: rootId, approvalSignature: null, enrollmentChallenge: null });
    for (const p of [plantedRoot, forged, unsigned]) server.keyPackages.set(p.id, [{ ciphersuite: 1, ref: `ref-${p.id}`, data: "AAAA" }]);
    void root;
    // a legitimate chain of depth 3: ios (root) approves desktop, desktop approves laptop
    const bobDesktop = await makeClient(server, "acc-bob-0001", "Bob desktop", "desktop");
    await bobIos.client.instance.refreshPending();
    await bobIos.client.instance.approve(bobDesktop.client.instanceId!);
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    const bobLaptop = await makeClient(server, "acc-bob-0001", "Bob laptop", "desktop");
    await bobDesktop.client.instance.refreshPending();
    await bobDesktop.client.instance.approve(bobLaptop.client.instanceId!);
    await waitFor(() => bobLaptop.client.instance.state() === "active");
    await waitFor(() => (server.keyPackages.get(bobLaptop.client.instanceId!)?.length ?? 0) > 0);
    expect(server.instances.get(bobLaptop.client.instanceId!)!.enrollmentChallenge).not.toBeNull();

    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bobIos, conv.id);
    await waitJoined(bobDesktop, conv.id);
    await waitJoined(bobLaptop, conv.id);
    const leaves = server.conversations.get(conv.id)!.leaves;
    expect([...leaves.keys()].sort()).toEqual([alice.client.instanceId, rootId, bobDesktop.client.instanceId, bobLaptop.client.instanceId].sort());
    for (const p of [plantedRoot, forged, unsigned]) {
      expect(leaves.has(p.id)).toBe(false);
      expect(server.keyPackages.get(p.id)).toHaveLength(1); // never even claimed
    }
    await alice.client.messages.send(conv.id, "to all three");
    await waitForText(bobLaptop, conv.id, "to all three");
    await stopAll(alice, bobIos, bobDesktop, bobLaptop);
  });

  it("(j) registration recovery: storage wiped, secret kept → 409 idempotency_conflict → the listed instance is adopted", async () => {
    const server = fakeServer();
    const secrets = new MemorySecrets();
    const bob1 = await makeClient(server, "acc-bob-0001", "Bob", "ios", { storage: new MemoryStorage(), secrets });
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob1, conv.id);
    const id = bob1.client.instanceId!;
    await bob1.client.stop();
    const bob2 = await makeClient(server, "acc-bob-0001", "Bob", "ios", { storage: new MemoryStorage(), secrets });
    expect(bob2.client.instanceId).toBe(id);
    expect(bob2.client.instance.state()).toBe("active");
    expect(server.requestLog.some((r) => r.method === "POST" && r.path === "/v1/instances" && r.status === 409)).toBe(true);
    expect(server.instancesOf("acc-bob-0001")).toHaveLength(1);
    // the wiped store lost the group state; the leaf exists server-side, so the conversation is listed but not readable
    await waitFor(() => bob2.client.conversations.get(conv.id) !== undefined);
    expect(bob2.client.conversations.get(conv.id)?.joined).toBe(false);
    // a key that matches no live instance is refused rather than silently re-registered
    server.instances.get(id)!.status = "revoked";
    const bob3 = await makeClient(server, "acc-bob-0001", "Bob", "ios", { storage: new MemoryStorage(), secrets }, false);
    const { InvalidStateError } = await import("../errors");
    await expect(bob3.client.start()).rejects.toBeInstanceOf(InvalidStateError);
    await stopAll(alice, bob2);
  });

  it("(l) instance.current() is referentially stable until the instance topic emits", async () => {
    const server = fakeServer();
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    let emitted = 0;
    const off = bob.client.subscribe("instance", () => emitted++);
    const a = bob.client.instance.current();
    expect(a).not.toBeNull();
    expect(bob.client.instance.current()).toBe(a);
    expect(bob.client.instance.current()).toBe(a);
    // A refresh re-reads the listing; `lastSeenAt` moves with every signed request, so the snapshot may
    // change — but only together with an emission, never silently.
    const before = emitted;
    await bob.client.instance.refresh();
    const afterRefresh = bob.client.instance.current();
    if (emitted === before) expect(afterRefresh).toBe(a);
    else expect(afterRefresh).not.toBe(a);
    expect(bob.client.instance.current()).toBe(afterRefresh);
    const mark = emitted;
    await bob.client.instance.revoke(bob.client.instanceId!);
    expect(emitted).toBeGreaterThan(mark);
    const b = bob.client.instance.current();
    expect(b).not.toBe(afterRefresh);
    expect(b?.status).toBe("revoked");
    expect(bob.client.instance.current()).toBe(b);
    off();
    await stopAll(bob);
  });

  it("(m) loadOlder respects `limit` and reports reachedStart", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    for (let i = 1; i <= 7; i++) await alice.client.messages.send(conv.id, `n${i}`);
    await waitForText(bob, conv.id, "n7");
    const all = bob.client.messages.timeline(conv.id);
    const last = all[all.length - 1];
    const page = await bob.client.messages.loadOlder(conv.id, last.id, 3);
    expect(texts(page.items)).toEqual(["n4", "n5", "n6"]);
    expect(page.reachedStart).toBe(false);
    const rest = await bob.client.messages.loadOlder(conv.id, page.items[0].id, 3);
    expect(texts(rest.items)).toEqual(["n1", "n2", "n3"]);
    expect(rest.reachedStart).toBe(true);
    expect((await bob.client.messages.loadOlder(conv.id)).items).toHaveLength(7); // default limit 50
    await stopAll(alice, bob);
  });

  it("(n) a pending instance's own view carries its enrollment challenge and the approver's fingerprint; gone once active; never on others", async () => {
    const server = fakeServer();
    const bobIos = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    expect(bobIos.client.instance.current()?.enrollment).toBeUndefined(); // bootstrap: never pending
    const bobDesktop = await makeClient(server, "acc-bob-0001", "Bob desktop", "desktop");
    expect(bobDesktop.client.instance.state()).toBe("pending-approval");
    const own = bobDesktop.client.instance.current()!;
    expect(own.enrollment).toBeDefined();
    expect(own.enrollment!.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);
    expect(bobDesktop.client.instance.current()).toBe(own); // stable
    await bobIos.client.instance.refreshPending();
    const pending = bobIos.client.instance.pending().find((p) => p.instance.id === bobDesktop.client.instanceId)!;
    expect(pending.challenge).toBe(own.enrollment!.challenge);
    expect(pending.fingerprint).toBe(own.enrollment!.fingerprint);
    expect(pending.instance.enrollment).toBeUndefined(); // the approver's view of the OTHER instance carries none
    expect(bobIos.client.instance.list().every((i) => i.enrollment === undefined)).toBe(true);
    await bobIos.client.instance.approve(pending.instance.id, pending.challenge);
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    expect(bobDesktop.client.instance.current()?.enrollment).toBeUndefined();
    expect(bobDesktop.client.instance.current()).not.toBe(own);
    await stopAll(bobIos, bobDesktop);
  });

  it("(k) push token registration goes to PUT/DELETE /v1/instances/me/push, signed", async () => {
    const server = fakeServer();
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    await bob.client.instance.setPushToken("apns", "device-token-1");
    const inst = server.instances.get(bob.client.instanceId!)!;
    expect(inst.pushToken).toBe("device-token-1");
    expect(inst.pushProvider).toBe("apns");
    await bob.client.instance.clearPushToken();
    expect(inst.pushToken).toBeNull();
    const calls = server.requestLog.filter((r) => r.path === "/v1/instances/me/push");
    expect(calls.map((c) => [c.method, c.status, c.instanceId])).toEqual([["PUT", 204, inst.id], ["DELETE", 204, inst.id]]);
    await stopAll(bob);
  });
});

describe("contract details", () => {
  it("a DM with an account the server has never seen fails with NotFoundError; one whose instances are all revoked is created with no other leaf", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const { NotFoundError } = await import("../errors");
    await expect(alice.client.conversations.createDirect("acc-nobody-01")).rejects.toBeInstanceOf(NotFoundError);
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    await bob.client.instance.revoke(bob.client.instanceId!);
    await waitFor(() => bob.client.instance.state() === "revoked");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    expect(conv.joined).toBe(true);
    expect(server.conversations.get(conv.id)!.leaves.size).toBe(1);
    await stopAll(alice, bob);
  });
});
