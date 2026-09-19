/**
 * Status updates over the fake server, end to end.
 *
 * What is proven here is the part the server cannot be trusted with: the body
 * is sealed before it leaves, only a device the key was sealed to can open it,
 * and a status whose signature does not check out is not shown at all.
 */
import { describe, expect, it } from "vitest";
import { fakeServer, makeClient, stopAll, waitFor, waitJoined } from "./e2eHelpers";

async function pair() {
  const server = fakeServer();
  const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
  const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
  const conv = await alice.client.conversations.createDirect("acc-bob-0001");
  await waitJoined(bob, conv.id);
  return { server, alice, bob };
}

describe("status updates", () => {
  it("reaches a recipient who shares a conversation, and nobody else", async () => {
    const { server, alice, bob } = await pair();
    const stranger = await makeClient(server, "acc-stranger1", "Stranger", "web");

    await alice.client.statuses.post({ kind: "text", caption: "at the canal", audience: { mode: "all", accountIds: [] } });

    await waitFor(() => bob.client.statuses.list().length === 1);
    const [seen] = bob.client.statuses.list();
    expect(seen.caption).toBe("at the canal");
    expect(seen.authorAccountId).toBe("acc-alice-01");
    expect(seen.mine).toBe(false);

    await stranger.client.statuses.refresh();
    expect(stranger.client.statuses.list()).toEqual([]);

    await stopAll(alice, bob, stranger);
  });

  it("leaves the server holding nothing it can read", async () => {
    const { server, alice, bob } = await pair();
    await alice.client.statuses.post({ kind: "text", caption: "a secret", audience: { mode: "all", accountIds: [] } });
    await waitFor(() => bob.client.statuses.list().length === 1);

    // The stored body is not text at all, so it is searched as BYTES — the
    // same sweep the backend suites end with.
    const needle = Buffer.from("a secret", "utf8");
    for (const row of server.statuses.values()) {
      expect(Buffer.from(row.payload, "base64").includes(needle)).toBe(false);
    }
    await stopAll(alice, bob);
  });

  it("shows the author their own without a round trip, and counts it as seen", async () => {
    const { alice, bob } = await pair();
    await alice.client.statuses.post({ kind: "text", caption: "mine", audience: { mode: "all", accountIds: [] } });
    const [own] = alice.client.statuses.list();
    expect(own).toMatchObject({ mine: true, seen: true, caption: "mine" });
    await stopAll(alice, bob);
  });

  it("honours an audience that excludes somebody", async () => {
    const { server, alice, bob } = await pair();
    const carol = await makeClient(server, "acc-carol-01", "Carol", "web");
    const conv = await alice.client.conversations.createDirect("acc-carol-01");
    await waitJoined(carol, conv.id);

    await alice.client.statuses.post({
      kind: "text",
      caption: "not for carol",
      audience: { mode: "except", accountIds: ["acc-carol-01"] },
    });

    await waitFor(() => bob.client.statuses.list().length === 1);
    await carol.client.statuses.refresh();
    expect(carol.client.statuses.list()).toEqual([]);
    await stopAll(alice, bob, carol);
  });

  it("honours an audience of exactly one", async () => {
    const { server, alice, bob } = await pair();
    const carol = await makeClient(server, "acc-carol-01", "Carol", "web");
    const conv = await alice.client.conversations.createDirect("acc-carol-01");
    await waitJoined(carol, conv.id);

    await alice.client.statuses.post({
      kind: "text",
      caption: "only carol",
      audience: { mode: "only", accountIds: ["acc-carol-01"] },
    });

    await waitFor(() => carol.client.statuses.list().length === 1);
    await bob.client.statuses.refresh();
    expect(bob.client.statuses.list()).toEqual([]);
    await stopAll(alice, bob, carol);
  });

  it("carries a picture as its own encrypted blob, fetched only when asked for", async () => {
    const { alice, bob } = await pair();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    await alice.client.statuses.post({
      kind: "image",
      caption: "the balcony",
      media: { bytes, mime: "image/png", width: 2, height: 2 },
      audience: { mode: "all", accountIds: [] },
    });

    await waitFor(() => bob.client.statuses.list().length === 1);
    const [seen] = bob.client.statuses.list();
    expect(seen.hasMedia).toBe(true);
    expect(await bob.client.statuses.media(seen.id)).toEqual(bytes);
    await stopAll(alice, bob);
  });

  it("refuses a status whose signature does not check out, rather than drawing it", async () => {
    const { server, alice, bob } = await pair();
    await alice.client.statuses.post({ kind: "text", caption: "real", audience: { mode: "all", accountIds: [] } });
    await waitFor(() => bob.client.statuses.list().length === 1);

    // A forged signature, and then the device meets the status for the FIRST
    // time — the same app, restarted, with its storage and secrets intact.
    for (const row of server.statuses.values()) row.signature = Buffer.alloc(64, 9).toString("base64");
    await bob.client.stop();
    const restarted = await makeClient(server, bob.accountId, "Bob", "ios", {
      storage: bob.storage,
      secrets: bob.secrets,
    });
    await restarted.client.statuses.refresh();
    expect(restarted.client.statuses.list()).toEqual([]);

    await stopAll(alice, restarted);
  });

  it("tells the author it was seen, and names only the viewers who publish it", async () => {
    const { server, alice, bob } = await pair();
    await alice.client.statuses.post({ kind: "text", caption: "seen?", audience: { mode: "all", accountIds: [] } });
    await waitFor(() => bob.client.statuses.list().length === 1);
    const [seen] = bob.client.statuses.list();

    await bob.client.statuses.view(seen.id);
    const named = await alice.client.statuses.viewers(seen.id);
    expect(named).toEqual({ accounts: ["acc-bob-0001"], total: 1 });

    // With receipts off, the same view counts and is not named.
    server.statusReceiptsOff.add("acc-bob-0001");
    const second = await alice.client.statuses.post({
      kind: "text",
      caption: "again",
      audience: { mode: "all", accountIds: [] },
    });
    await waitFor(() => bob.client.statuses.list().length === 2);
    await bob.client.statuses.view(second);
    const quiet = await alice.client.statuses.viewers(second);
    expect(quiet).toEqual({ accounts: [], total: 1 });

    await stopAll(alice, bob);
  });

  it("takes one down before its deadline, and it stops being anybody's", async () => {
    const { alice, bob } = await pair();
    const id = await alice.client.statuses.post({ kind: "text", caption: "oops", audience: { mode: "all", accountIds: [] } });
    await waitFor(() => bob.client.statuses.list().length === 1);

    await alice.client.statuses.remove(id);
    expect(alice.client.statuses.list()).toEqual([]);
    await bob.client.statuses.refresh();
    expect(bob.client.statuses.list()).toEqual([]);

    await stopAll(alice, bob);
  });

  it("keeps the deadline it verified, whatever the server later claims", async () => {
    const { server, alice, bob } = await pair();
    await alice.client.statuses.post({ kind: "text", caption: "ephemeral", audience: { mode: "all", accountIds: [] } });
    await waitFor(() => bob.client.statuses.list().length === 1);
    const signed = bob.client.statuses.list()[0].expiresAt;

    // A server that rewrites the deadline and keeps serving it. The device
    // already checked a signature covering the original, so that is the one it
    // holds — and a later refresh does not launder the new claim in.
    server.keepExpiredStatuses = true;
    for (const row of server.statuses.values()) row.expiresAt = new Date(Date.now() + 400 * 24 * 3600_000).toISOString();
    await bob.client.statuses.refresh();

    expect(bob.client.statuses.list()[0].expiresAt).toBe(signed);
    await stopAll(alice, bob);
  });

  it("answers an empty list on a client that was never started", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web", undefined, false);
    const first = alice.client.statuses.list();
    expect(first).toEqual([]);
    expect(alice.client.statuses.list()).toBe(first);
  });
});
