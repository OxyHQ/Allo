/**
 * The real SDK against the real backend (Phase 2: instances, MLS, media).
 *
 * The harness (`harness.ts`) is `createApp` with the production
 * `requireInstance`, the production Socket.IO server and a real Postgres;
 * three `@allo/core` clients over real HTTP and real sockets on an ephemeral
 * port. The only double is Oxy.
 *
 * What this proves that the unit suites cannot: the SDK's request signing,
 * its MLS commits, welcomes, epoch handling and media encryption all round-trip
 * through THIS server's rules — and the server never holds a byte of
 * plaintext, asserted by searching every stored payload and blob.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { MediaRef } from "@allo/core";
import * as schema from "../../db/schema";
import { logger } from "../../utils/logger";
import { Harness, stopAll, texts, waitFor, waitForText, waitJoined } from "./harness";

const h = new Harness();
beforeAll(() => h.boot(), 180_000);
afterAll(() => h.shutdown());

describe("@allo/core against the real backend", () => {
  it("DM: Alice(web) and Bob(ios) exchange text both ways over real HTTP and sockets", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    const bob = await h.makeClient(bobId, "Bob", "ios");
    expect(alice.client.instance.state()).toBe("active");
    expect(bob.client.instance.state()).toBe("active");
    await waitFor(() => alice.client.sync.state() === "live" && bob.client.sync.state() === "live");

    const conv = await alice.client.conversations.createDirect(bobId);
    expect(conv.kind).toBe("dm");
    await waitJoined(bob, conv.id);

    const hiBob = h.unique("hi bob");
    await alice.client.messages.send(conv.id, hiBob);
    const onBob = await waitForText(bob, conv.id, hiBob);
    expect(onBob.senderAccountId).toBe(aliceId);
    expect(onBob.isOwn).toBe(false);

    const hiAlice = h.unique("hi alice");
    await bob.client.messages.send(conv.id, hiAlice, { replyTo: onBob.id });
    const reply = await waitForText(alice, conv.id, hiAlice);
    expect(reply.replyTo).toBe(onBob.id);

    // The server's view: two leaves, both active, one DM row.
    const [row] = await h.db.select().from(schema.conversations).where(eq(schema.conversations.id, conv.id));
    expect(row.kind).toBe("dm");
    const leaves = await h.db.select().from(schema.conversationLeaves).where(eq(schema.conversationLeaves.conversationId, conv.id));
    expect(leaves.map((l) => l.state)).toEqual(["active", "active"]);

    await stopAll(alice, bob);
  }, 60_000);

  it("second device: Bob(desktop) pending → approved by Bob(ios) → added → decrypts Alice's next message, and its own reaches everyone", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    const bobIos = await h.makeClient(bobId, "Bob iOS", "ios");
    const conv = await alice.client.conversations.createDirect(bobId);
    await waitJoined(bobIos, conv.id);
    const before = h.unique("before desktop");
    await alice.client.messages.send(conv.id, before);
    await waitForText(bobIos, conv.id, before);

    const bobDesktop = await h.makeClient(bobId, "Bob desktop", "desktop");
    expect(bobDesktop.client.instance.state()).toBe("pending-approval");
    await bobIos.client.instance.refreshPending();
    const pending = bobIos.client.instance.pending();
    expect(pending.map((p) => p.instance.id)).toEqual([bobDesktop.client.instanceId]);
    await expect(bobIos.client.instance.approve(pending[0].instance.id, "not-the-challenge")).rejects.toThrow(/challenge/);
    await bobIos.client.instance.approve(pending[0].instance.id, pending[0].challenge);

    // The approval reaches the desktop over its socket (`instance.approved`); the
    // challenge stays on the row and is now published on the public projection.
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    const [desktopRow] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, bobDesktop.client.instanceId!));
    expect(desktopRow.status).toBe("active");
    expect(desktopRow.enrollmentChallenge).toBe(pending[0].challenge);
    expect(desktopRow.approvedByInstanceId).toBe(bobIos.client.instanceId);

    await waitFor(async () => (await h.keyPackagesOf(bobDesktop.client.instanceId!)) > 0);
    await bobIos.client.sync.now();
    await waitJoined(bobDesktop, conv.id);
    // History before the join is not decryptable from the group: it reaches the
    // desktop only through the E2EE transfer the elector (Bob iOS) offers it once
    // it is added. `phase3.realdb.test.ts` takes that path apart.
    await waitForText(bobDesktop, conv.id, before, 20_000);

    const after = h.unique("after desktop");
    await alice.client.messages.send(conv.id, after);
    await waitForText(bobIos, conv.id, after);
    await waitForText(bobDesktop, conv.id, after);

    const fromDesktop = h.unique("from desktop");
    await bobDesktop.client.messages.send(conv.id, fromDesktop);
    await waitForText(bobIos, conv.id, fromDesktop);
    await waitForText(alice, conv.id, fromDesktop);
    expect(bobIos.client.messages.timeline(conv.id).find((i) => i.content.kind === "text" && i.content.body === fromDesktop)?.isOwn).toBe(true);
    await waitFor(() => alice.client.conversations.get(conv.id)?.epoch === bobDesktop.client.conversations.get(conv.id)?.epoch);

    const leaves = await h.db.select().from(schema.conversationLeaves).where(eq(schema.conversationLeaves.conversationId, conv.id));
    expect(leaves.filter((l) => l.state === "active")).toHaveLength(3);

    await stopAll(alice, bobIos, bobDesktop);
  }, 90_000);

  it("revocation: Bob(desktop) revokes Bob(ios); the remaining leaf removes it and its later sync cannot read what follows", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    const bobIos = await h.makeClient(bobId, "Bob iOS", "ios");
    const conv = await alice.client.conversations.createDirect(bobId);
    await waitJoined(bobIos, conv.id);
    const bobDesktop = await h.makeClient(bobId, "Bob desktop", "desktop");
    await bobIos.client.instance.refreshPending();
    await bobIos.client.instance.approve(bobDesktop.client.instanceId!);
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    await waitFor(async () => (await h.keyPackagesOf(bobDesktop.client.instanceId!)) > 0);
    await bobIos.client.sync.now();
    await waitJoined(bobDesktop, conv.id);
    await waitFor(() => alice.client.conversations.get(conv.id)!.epoch === bobDesktop.client.conversations.get(conv.id)!.epoch);
    const epochBefore = alice.client.conversations.get(conv.id)!.epoch;

    await bobDesktop.client.instance.revoke(bobIos.client.instanceId!);
    await waitFor(() => bobIos.client.instance.state() === "revoked");
    // Server side: revoked, sockets cut, leaf marked removed pending a commit,
    // then the desktop's Remove commit sets the epoch.
    await waitFor(async () => !(await h.sockets.realtime.isInstanceConnected(bobIos.client.instanceId!)));
    await waitFor(() => alice.client.conversations.get(conv.id)!.epoch === epochBefore + 1, 20_000);
    const [iosLeaf] = await h.db
      .select()
      .from(schema.conversationLeaves)
      .where(and(eq(schema.conversationLeaves.conversationId, conv.id), eq(schema.conversationLeaves.instanceId, bobIos.client.instanceId!)));
    expect(iosLeaf.state).toBe("removed");
    expect(iosLeaf.removedEpoch).toBe(epochBefore + 1);

    const afterRevoke = h.unique("after revoke");
    await alice.client.messages.send(conv.id, afterRevoke);
    await waitForText(bobDesktop, conv.id, afterRevoke);

    // The revoked instance: the SDK has stopped its loops (a later `sync.now()`
    // is a no-op, not a throw), the server refuses its signature outright, and
    // nothing it holds can show the message.
    await bobIos.client.sync.now().catch(() => undefined);
    expect(texts(bobIos.client.messages.timeline(conv.id))).not.toContain(afterRevoke);
    expect(bobIos.client.instance.state()).toBe("revoked");
    const [iosRow] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, bobIos.client.instanceId!));
    expect(iosRow.status).toBe("revoked");
    expect(await h.sockets.realtime.isInstanceConnected(bobIos.client.instanceId!)).toBe(false);
    // And the server wrote no delivery for it.
    const deliveries = await h.db
      .select()
      .from(schema.instanceDeliveries)
      .where(eq(schema.instanceDeliveries.instanceId, bobIos.client.instanceId!));
    const afterRevokeEvents = await h.db
      .select()
      .from(schema.conversationEvents)
      .where(and(eq(schema.conversationEvents.conversationId, conv.id), eq(schema.conversationEvents.kind, "app_message")));
    const last = afterRevokeEvents[afterRevokeEvents.length - 1];
    expect(deliveries.map((d) => d.eventId)).not.toContain(last.id);

    await stopAll(alice, bobIos, bobDesktop);
  }, 90_000);

  it("epoch conflict: Alice and Bob(desktop) add Carol concurrently → one 409, Carol added once, everyone agrees", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const carolId = h.account("carol");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    const bob = await h.makeClient(bobId, "Bob desktop", "desktop");
    const carol = await h.makeClient(carolId, "Carol", "android");
    const group = await alice.client.conversations.createGroup([bobId]);
    await waitJoined(bob, group.id);
    await waitFor(async () => (await h.keyPackagesOf(carol.client.instanceId!)) >= 2);

    const infoCalls = vi.mocked(logger.info).mock.calls.length;
    await Promise.all([alice.client.conversations.addMember(group.id, carolId), bob.client.conversations.addMember(group.id, carolId)]);
    for (const c of [alice, bob]) {
      await c.client.sync.flush();
      await c.client.sync.now();
    }
    await waitJoined(carol, group.id);
    for (const c of [alice, bob, carol]) {
      await c.client.sync.flush();
      await c.client.sync.now();
    }

    // The 409 is visible in the request log (route template + status only).
    const conflicts = vi
      .mocked(logger.info)
      .mock.calls.slice(infoCalls)
      .filter(([message, meta]) => message === "HTTP request completed" && (meta as { status: number; route: string }).status === 409);
    expect(conflicts.length).toBeGreaterThanOrEqual(1);
    expect((conflicts[0][1] as { route: string }).route).toBe("/v1/conversations/:id/events");

    const carolLeaves = await h.db
      .select()
      .from(schema.conversationLeaves)
      .where(and(eq(schema.conversationLeaves.conversationId, group.id), eq(schema.conversationLeaves.accountId, carolId)));
    expect(carolLeaves).toHaveLength(1);
    expect(carolLeaves[0].state).toBe("active");
    const commits = await h.db
      .select()
      .from(schema.conversationEvents)
      .where(and(eq(schema.conversationEvents.conversationId, group.id), eq(schema.conversationEvents.kind, "mls_commit")));
    expect(commits).toHaveLength(2);
    const epochs = [alice, bob, carol].map((c) => c.client.conversations.get(group.id)!.epoch);
    expect(new Set(epochs).size).toBe(1);
    const [row] = await h.db.select().from(schema.conversations).where(eq(schema.conversations.id, group.id));
    expect(row.currentEpoch).toBe(epochs[0]);

    const three = h.unique("three of us");
    await alice.client.messages.send(group.id, three);
    await waitForText(bob, group.id, three);
    await waitForText(carol, group.id, three);
    await stopAll(alice, bob, carol);
  }, 90_000);

  it("media: an uploaded file's plaintext is nowhere on the server; the recipient decrypts it", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    const bob = await h.makeClient(bobId, "Bob", "ios");
    const conv = await alice.client.conversations.createDirect(bobId);
    await waitJoined(bob, conv.id);
    const bytes = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
    await alice.client.media.upload(conv.id, bytes, { kind: "file", filename: "data.bin", mime: "application/octet-stream", caption: h.unique("cap") });
    await waitFor(() => bob.client.messages.timeline(conv.id).some((i) => i.content.kind === "media"));
    const item = bob.client.messages.timeline(conv.id).find((i) => i.content.kind === "media")!;
    const media = (item.content as { media: { ref: MediaRef; size: number } }).media;
    expect(media.size).toBe(5000);
    const got = await bob.client.media.download(media.ref);
    expect(Buffer.compare(Buffer.from(got), Buffer.from(bytes))).toBe(0);

    // The blob row holds ciphertext, is retained (referenced by the event), and
    // no blob anywhere contains a window of the plaintext.
    const [blob] = await h.db.select().from(schema.blobs).where(eq(schema.blobs.id, media.ref.blobId));
    expect(blob.expiresAt).toBeNull();
    expect(blob.size).toBeGreaterThanOrEqual(5000);
    const stored = await h.db.select().from(schema.blobBytes);
    expect(stored.length).toBeGreaterThanOrEqual(1);
    const window = Buffer.from(bytes.subarray(0, 64));
    for (const row of stored) expect(Buffer.from(row.data).includes(window)).toBe(false);
    for (const payload of await h.allPayloads()) expect(payload.includes(window)).toBe(false);
    await stopAll(alice, bob);
  }, 60_000);

  it("no payload on the server contains the plaintext of any message h.sent above", async () => {
    expect(h.sent.length).toBeGreaterThanOrEqual(8);
    const payloads = await h.allPayloads();
    expect(payloads.length).toBeGreaterThanOrEqual(h.sent.length);
    for (const text of h.sent) {
      const needle = Buffer.from(text, "utf8");
      for (const payload of payloads) expect(payload.includes(needle), `payload contains "${text}"`).toBe(false);
    }
    // Control: the search would find a payload that DID carry plaintext.
    const [probe] = h.sent;
    expect(Buffer.concat([Buffer.from("x"), Buffer.from(probe, "utf8")]).includes(Buffer.from(probe, "utf8"))).toBe(true);
  });
});
