/**
 * Members without a device. A conversation may name an account that has not
 * installed Allo (the server has never seen it, `GET /v1/accounts/:id/instances`
 * is 404) or whose devices are all gone. Creation still succeeds, the account is
 * a joined member with no leaf, application messages nobody else could read are
 * held in the outbox, and the conversation's elector adds the account's first
 * device when the server nudges the conversation (or on its next look).
 */
import { describe, expect, it } from "vitest";
import type { Platform } from "@allo/shared-types";
import { fakeServer, makeClient, stopAll, texts, waitFor, waitForText, waitJoined, type TestClient } from "./e2eHelpers";
import { createAlloClient } from "../client";
import type { FakeAlloServer } from "../testing/fakeServer";
import { FakeSession, MemorySecrets, MemoryStorage } from "../testing/memoryAdapters";
import { sleep } from "../util/async";

const ALICE = "acc-alice-01";
const BOB = "acc-bob-0001";
const CAROL = "acc-carol-01";

const pendingOf = (c: TestClient, conversationId: string) => c.client.messages.timeline(conversationId).filter((i) => i.sendState === "pending");
const commitsBy = (server: FakeAlloServer, conversationId: string, instanceId: string | null) =>
  server.eventsOf(conversationId).filter((e) => e.kind === "mls_commit" && e.senderInstanceId === instanceId);
const claimsBy = (server: FakeAlloServer, instanceId: string | null) => server.requestLog.filter((r) => r.path === "/v1/key-packages/claim" && r.instanceId === instanceId).length;
const lookupsOf = (server: FakeAlloServer, accountId: string) => server.requestLog.filter((r) => r.path === `/v1/accounts/${accountId}/instances`).length;

/** A server and clients on ONE steerable clock, so a test can walk past the elector's one-minute throttle without waiting it out. */
function clockedServer() {
  const server = fakeServer();
  let clock = Date.now();
  server.now = () => clock;
  const client = async (accountId: string, name: string, platform: Platform): Promise<TestClient> => {
    const storage = new MemoryStorage();
    const secrets = new MemorySecrets();
    const c = createAlloClient({
      baseUrl: server.baseUrl,
      appId: "allo",
      platform,
      displayName: name,
      session: FakeSession.for(accountId),
      storage,
      secrets,
      transport: { fetch: server.fetch, socketFactory: server.socketFactory },
      syncIntervalMs: 60_000,
      keyPackageTarget: 6,
      now: () => clock,
    });
    await c.start();
    return { client: c, storage, secrets, accountId, name };
  };
  return { server, client, advance: (ms: number) => void (clock += ms) };
}

describe("members without an instance", () => {
  it("(a) a DM with an account that never installed Allo: created, held, then delivered once the account's first device is added", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");

    // (d) the 404 for a never-seen account is not an error here
    expect(server.instancesOf(BOB)).toHaveLength(0);
    const conv = await alice.client.conversations.createDirect(BOB);
    expect(server.requestLog.some((r) => r.path === `/v1/accounts/${BOB}/instances` && r.status === 404)).toBe(true);
    expect(conv.joined).toBe(true);
    expect(conv.memberAccountIds.sort()).toEqual([ALICE, BOB]);
    expect(conv.unreachableMemberAccountIds).toEqual([BOB]);
    expect(alice.client.conversations.get(conv.id)).toBe(conv); // stable
    expect(server.conversations.get(conv.id)!.leaves.size).toBe(1); // only Alice's leaf; no initial commit
    expect(server.eventsOf(conv.id).filter((e) => e.kind === "mls_commit")).toHaveLength(0);

    // messages are held: pending, marked, never sent, no attempt burnt
    const k1 = await alice.client.messages.send(conv.id, "first");
    const k2 = await alice.client.messages.send(conv.id, "second");
    await alice.client.sync.flush();
    await alice.client.sync.now();
    await sleep(50);
    const held = pendingOf(alice, conv.id);
    expect(held.map((i) => i.localKey)).toEqual([k1, k2]);
    expect(held.every((i) => i.holdReason === "no_reachable_member")).toBe(true);
    expect(server.eventsOf(conv.id).filter((e) => e.kind === "app_message")).toHaveLength(0);
    expect(server.requestLog.filter((r) => r.method === "POST" && r.path === `/v1/conversations/${conv.id}/events`)).toHaveLength(0);
    expect(alice.client.conversations.get(conv.id)?.lastMessage?.holdReason).toBe("no_reachable_member");

    // Bob installs Allo: a bootstrap instance. The server nudges Alice's leaf; her elector adds Bob's device.
    const bob = await makeClient(server, BOB, "Bob", "ios");
    await waitJoined(bob, conv.id, 15_000);
    await waitForText(bob, conv.id, "second", 15_000);
    expect(texts(bob.client.messages.timeline(conv.id))).toEqual(["first", "second"]);
    expect(bob.client.conversations.get(conv.id)?.memberAccountIds.sort()).toEqual([ALICE, BOB]);
    expect(bob.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([]);

    // the held items were released: accepted (or beyond), no hold reason, nothing pending
    await waitFor(() => pendingOf(alice, conv.id).length === 0);
    const sent = alice.client.messages.timeline(conv.id).filter((i) => i.content.kind === "text");
    expect(sent.map((i) => i.localKey)).toEqual([k1, k2]);
    expect(sent.every((i) => i.seq !== null && i.holdReason === undefined && i.sendState !== "pending")).toBe(true);
    expect(alice.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([]);
    expect(commitsBy(server, conv.id, alice.client.instanceId)).toHaveLength(1);

    // and it keeps working both ways
    await bob.client.messages.send(conv.id, "hi alice");
    await waitForText(alice, conv.id, "hi alice");
    await stopAll(alice, bob);
  });

  it("(b) a group with one reachable and one instance-less member sends at once; the late member gets the welcome but no earlier history", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");
    const bob = await makeClient(server, BOB, "Bob", "ios");
    const group = await alice.client.conversations.createGroup([BOB, CAROL]);
    expect(group.memberAccountIds.sort()).toEqual([ALICE, BOB, CAROL]);
    expect(group.unreachableMemberAccountIds).toEqual([CAROL]);
    await waitJoined(bob, group.id);
    expect(bob.client.conversations.get(group.id)?.unreachableMemberAccountIds).toEqual([CAROL]);

    // Bob can read it, so nothing is held
    const key = await alice.client.messages.send(group.id, "hi both");
    await waitForText(bob, group.id, "hi both");
    expect(alice.client.messages.timeline(group.id).find((i) => i.localKey === key)?.holdReason).toBeUndefined();
    expect(alice.client.messages.timeline(group.id).find((i) => i.localKey === key)?.seq).not.toBeNull();

    // Carol installs: added by the elector (Alice, the lowest leaf), not by Bob
    const carol = await makeClient(server, CAROL, "Carol", "android");
    await waitJoined(carol, group.id, 15_000);
    await waitFor(() => alice.client.conversations.get(group.id)?.unreachableMemberAccountIds.length === 0);
    await waitFor(() => bob.client.conversations.get(group.id)?.unreachableMemberAccountIds.length === 0);
    expect(commitsBy(server, group.id, bob.client.instanceId)).toHaveLength(0);
    expect(server.requestLog.some((r) => r.status === 409)).toBe(false);

    // No cross-account history: "hi both" was encrypted at an epoch Carol's leaf never held; only what follows reaches her.
    await alice.client.messages.send(group.id, "hi three");
    await waitForText(carol, group.id, "hi three", 10_000);
    await waitForText(bob, group.id, "hi three");
    expect(texts(carol.client.messages.timeline(group.id))).toEqual(["hi three"]);
    expect(carol.client.conversations.get(group.id)?.memberAccountIds.sort()).toEqual([ALICE, BOB, CAROL]);
    await stopAll(alice, bob, carol);
  });

  it("(c) two devices of the creator: each holds what it wrote; the non-elector never adds Bob, even when it alone hears he installed; the elector does when it looks", async () => {
    const { server, client, advance } = clockedServer();
    const aliceWeb = await client(ALICE, "Alice web", "web");
    const conv = await aliceWeb.client.conversations.createDirect(BOB);
    const aliceDesktop = await client(ALICE, "Alice desktop", "desktop");
    await aliceWeb.client.instance.refreshPending();
    await aliceWeb.client.instance.approve(aliceDesktop.client.instanceId!);
    await waitFor(() => aliceDesktop.client.instance.state() === "active");
    await waitFor(() => (server.keyPackages.get(aliceDesktop.client.instanceId!)?.length ?? 0) > 0);
    await aliceWeb.client.sync.now();
    await waitJoined(aliceDesktop, conv.id, 10_000);
    expect(aliceWeb.client.instanceId! < aliceDesktop.client.instanceId!).toBe(true); // web is the elector on both rules
    expect(aliceDesktop.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([BOB]);

    const fromWeb = await aliceWeb.client.messages.send(conv.id, "from web");
    const fromDesktop = await aliceDesktop.client.messages.send(conv.id, "from desktop");
    await aliceWeb.client.sync.flush();
    await aliceDesktop.client.sync.flush();
    await sleep(50);
    expect(pendingOf(aliceWeb, conv.id).map((i) => [i.localKey, i.holdReason])).toEqual([[fromWeb, "no_reachable_member"]]);
    expect(pendingOf(aliceDesktop, conv.id).map((i) => [i.localKey, i.holdReason])).toEqual([[fromDesktop, "no_reachable_member"]]);
    expect(server.eventsOf(conv.id).filter((e) => e.kind === "app_message")).toHaveLength(0);
    expect(server.eventsOf(conv.id).filter((e) => e.kind === "mls_commit")).toHaveLength(1); // the desktop's own add
    const webClaims = claimsBy(server, aliceWeb.client.instanceId);

    // The elector is offline when Bob installs: only the desktop hears the server's nudge, and it must not step in.
    server.setOffline(aliceWeb.client.instanceId!, true);
    await waitFor(() => aliceWeb.client.sync.state() !== "live");
    const bob = await client(BOB, "Bob", "ios");
    await aliceDesktop.client.sync.now();
    await aliceDesktop.client.sync.flush();
    await sleep(100);
    expect(claimsBy(server, aliceDesktop.client.instanceId)).toBe(0);
    expect(commitsBy(server, conv.id, aliceDesktop.client.instanceId)).toHaveLength(0);
    expect([...server.conversations.get(conv.id)!.leaves.values()].some((l) => l.accountId === BOB)).toBe(false);
    expect(pendingOf(aliceDesktop, conv.id)).toHaveLength(1); // still held

    // The elector returns: it missed the nudge, so it waits out its throttle, then finds Bob on its own.
    server.setOffline(aliceWeb.client.instanceId!, false);
    await waitFor(() => aliceWeb.client.sync.state() === "live");
    await aliceWeb.client.sync.now();
    expect(claimsBy(server, aliceWeb.client.instanceId)).toBe(webClaims); // throttled: no lookup yet
    advance(61_000);
    await aliceWeb.client.sync.now();
    await aliceWeb.client.sync.flush();
    await waitJoined(bob, conv.id, 10_000);
    await waitFor(() => texts(bob.client.messages.timeline(conv.id)).length === 2, 10_000);
    expect(texts(bob.client.messages.timeline(conv.id)).sort()).toEqual(["from desktop", "from web"]);
    await waitFor(() => pendingOf(aliceWeb, conv.id).length === 0 && pendingOf(aliceDesktop, conv.id).length === 0);
    await waitForText(aliceWeb, conv.id, "from desktop");
    await waitForText(aliceDesktop, conv.id, "from web");

    // exactly one Add of Bob, by the elector
    expect(server.eventsOf(conv.id).filter((e) => e.kind === "mls_commit")).toHaveLength(2);
    expect(commitsBy(server, conv.id, aliceWeb.client.instanceId)).toHaveLength(2);
    expect(commitsBy(server, conv.id, aliceDesktop.client.instanceId)).toHaveLength(0);
    expect(claimsBy(server, aliceDesktop.client.instanceId)).toBe(0);
    expect(server.requestLog.some((r) => r.status === 409)).toBe(false);
    expect([...server.conversations.get(conv.id)!.leaves.values()].filter((l) => l.accountId === BOB)).toHaveLength(1);
    await stopAll(aliceWeb, aliceDesktop, bob);
  });

  it("(e) the elector's lookup is throttled to once a minute per account, and a nudge naming the conversation skips the wait", async () => {
    const { server, client, advance } = clockedServer();
    const alice = await client(ALICE, "Alice", "web");
    const conv = await alice.client.conversations.createDirect(BOB);
    expect(lookupsOf(server, BOB)).toBe(1); // creation asked once and found nobody
    await alice.client.sync.now();
    await alice.client.sync.now();
    expect(lookupsOf(server, BOB)).toBe(1); // within the minute the elector does not ask again
    advance(61_000);
    await alice.client.sync.now();
    expect(lookupsOf(server, BOB)).toBe(2); // a minute later it does
    await alice.client.sync.now();
    expect(lookupsOf(server, BOB)).toBe(2);
    server.emitTo(alice.client.instanceId!, "sync.nudge", { conversationId: conv.id });
    await waitFor(() => lookupsOf(server, BOB) === 3); // the nudge skips the throttle
    await alice.client.sync.now();
    expect(lookupsOf(server, BOB)).toBe(3); // and is consumed once
    expect(alice.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([BOB]);
    await stopAll(alice);
  });

  it("(f) a device listed before its key packages are up is retried within seconds, once; a second miss waits the full throttle", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, ALICE, "Alice", "web");
    const conv = await alice.client.conversations.createDirect(BOB);
    // Bob's first upload fails: he is active and listed, with nothing to claim.
    server.faults.push({ match: (m, p) => m === "PUT" && p === "/v1/key-packages", times: 1, status: 503, code: "unavailable" });
    const bob = await makeClient(server, BOB, "Bob", "ios");
    expect(server.keyPackages.get(bob.client.instanceId!) ?? []).toHaveLength(0);
    await alice.client.sync.now();
    await waitFor(() => lookupsOf(server, BOB) >= 2); // the nudge made Alice look
    await sleep(100);
    expect([...server.conversations.get(conv.id)!.leaves.values()].some((l) => l.accountId === BOB)).toBe(false);
    const claims = claimsBy(server, alice.client.instanceId);
    expect(claims).toBeGreaterThanOrEqual(1);
    // Bob's stock arrives a moment later (the low-water nudge is how the server asks for it)
    server.emitTo(bob.client.instanceId!, "keypackages.low", { available: 0 });
    await waitFor(() => (server.keyPackages.get(bob.client.instanceId!)?.length ?? 0) > 0);
    // no sync is driven from here: the elector's own retry (5 s, not 60) finds the packages and adds the device
    await waitJoined(bob, conv.id, 10_000);
    expect(alice.client.conversations.get(conv.id)?.unreachableMemberAccountIds).toEqual([]);
    await stopAll(alice, bob);
  });
});
