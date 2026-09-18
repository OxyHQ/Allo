/**
 * Phase 3 of the platform, the real SDK against the real backend: E2EE history
 * transfer between instances of one account, the encrypted account backup and
 * its recovery phrase, delivered receipts, thumbnails, and the transfer-key
 * contract.
 *
 * Same harness as the Phase 2 suite (`harness.ts`). What this adds to the
 * core package's own tests over its fake server is THIS server: its offer
 * rules, its chunk retention, its `history.offer` nudge over a real socket,
 * and the proof that none of it ever holds a byte of plaintext — every chunk,
 * manifest, sealed key and event payload is byte-searched for the texts sent.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { io } from "socket.io-client";
import { RecoveryPhraseError, backupKeyName, transferKeyName, validateRecoveryPhrase, type MediaView, type SocketFactory, type SocketLike } from "@allo/core";
import type { HistoryOfferEvent } from "@allo/shared-types";
import * as schema from "../../db/schema";
import { logger } from "../../utils/logger";
import { Harness, stopAll, texts, waitFor, waitForText, waitJoined, type TestClient } from "./harness";

const h = new Harness();
beforeAll(() => h.boot(), 180_000);
afterAll(() => h.shutdown());

const MEDIA = new Uint8Array(3000).map((_, i) => (i * 13) & 0xff);
const THUMB = new Uint8Array(200).map((_, i) => (i * 7 + 3) & 0xff);

/** Alice(web) ↔ Bob(ios) DM: six texts, alternating so `seq` order is send order, then one picture with a thumbnail. */
async function seedDm() {
  const aliceId = h.account("alice");
  const bobId = h.account("bob");
  const alice = await h.makeClient(aliceId, "Alice", "web");
  const bobIos = await h.makeClient(bobId, "Bob iOS", "ios");
  const conv = await alice.client.conversations.createDirect(bobId);
  await waitJoined(bobIos, conv.id);
  const messages: string[] = [];
  for (let i = 1; i <= 6; i++) {
    const from = i % 2 === 1 ? alice : bobIos;
    const to = i % 2 === 1 ? bobIos : alice;
    const text = h.unique(`message ${i}`);
    messages.push(text);
    await from.client.messages.send(conv.id, text);
    await waitForText(to, conv.id, text);
  }
  const caption = h.unique("picture");
  await alice.client.media.upload(conv.id, MEDIA, { kind: "image", filename: "pic.png", mime: "image/png", width: 40, height: 30, caption, thumbnail: { bytes: THUMB, mime: "image/jpeg", width: 8, height: 6 } });
  await waitFor(() => bobIos.client.messages.timeline(conv.id).some((i) => i.content.kind === "media"));
  return { aliceId, bobId, alice, bobIos, conv, messages, caption };
}

function mediaOf(c: TestClient, conversationId: string): MediaView {
  const item = c.client.messages.timeline(conversationId).find((i) => i.content.kind === "media");
  expect(item, "a media item in the timeline").toBeDefined();
  return (item!.content as { media: MediaView }).media;
}

const eq8 = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;

/** `true` when any of `haystacks` contains `needle` as bytes. */
function anyContains(haystacks: Buffer[], needle: string): boolean {
  const n = Buffer.from(needle, "utf8");
  return haystacks.some((buf) => buf.includes(n));
}

async function chunkBlobs(ids: string[]) {
  const rows = [] as Array<{ id: string; expiresAt: Date | null; data: Buffer }>;
  for (const id of ids) {
    const [blob] = await h.db.select().from(schema.blobs).where(eq(schema.blobs.id, id));
    const [bytes] = await h.db.select().from(schema.blobBytes).where(eq(schema.blobBytes.blobId, id));
    expect(blob, `blob row ${id}`).toBeDefined();
    expect(bytes, `blob bytes ${id}`).toBeDefined();
    rows.push({ id, expiresAt: blob.expiresAt, data: Buffer.from(bytes.data) });
  }
  return rows;
}

/** The backend's request log (route template + method + status), from the mocked logger. */
function requestLog(since = 0) {
  return vi
    .mocked(logger.info)
    .mock.calls.slice(since)
    .filter(([message]) => message === "HTTP request completed")
    .map(([, meta]) => meta as { method: string; route: string; status: number });
}
const logMark = () => vi.mocked(logger.info).mock.calls.length;

describe("history transfer", () => {
  it("a newly approved device is nudged over its socket, receives the six pre-join messages in order and the picture with its thumbnail; the server held ciphertext only and released the chunks", async () => {
    const { bobId, alice, bobIos, conv, messages, caption } = await seedDm();

    // The desktop's socket is the real socket.io-client, wrapped only to record what the server pushes at it.
    const offerEvents: HistoryOfferEvent[] = [];
    const socketFactory: SocketFactory = (url, auth) => {
      const socket = io(url, {
        autoConnect: false,
        reconnection: true,
        reconnectionDelay: 1000,
        auth: (cb) => {
          auth().then(
            (payload) => cb(payload as unknown as Record<string, unknown>),
            () => cb({}),
          );
        },
      });
      socket.onAny((event: string, payload: unknown) => {
        if (event === "history.offer") offerEvents.push(payload as HistoryOfferEvent);
      });
      return socket as unknown as SocketLike;
    };
    const bobDesktop = await h.makeClient(bobId, "Bob desktop", "desktop", { transport: { socketFactory } });
    expect(bobDesktop.client.instance.state()).toBe("pending-approval");
    expect(bobDesktop.client.history.progress()).toEqual({ phase: "idle", done: 0, total: 0 });
    const phases = new Set<string>();
    bobDesktop.client.subscribe("history", () => phases.add(bobDesktop.client.history.progress().phase));

    await bobIos.client.instance.refreshPending();
    const [pending] = bobIos.client.instance.pending();
    expect(pending.instance.id).toBe(bobDesktop.client.instanceId);
    await bobIos.client.instance.approve(pending.instance.id, pending.challenge);
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    // Both instances carry a transfer key: the desktop's is what the archive key gets sealed to.
    const [desktopRow] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, bobDesktop.client.instanceId!));
    expect(desktopRow.transferPublicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(bobDesktop.client.instance.current()?.transferPublicKey).toBe(desktopRow.transferPublicKey);

    // The elector (Bob iOS, the account's lowest leaf) adds the desktop on its next sync and offers it history once.
    await waitFor(async () => (await h.keyPackagesOf(bobDesktop.client.instanceId!)) > 0);
    await bobIos.client.sync.now();
    await waitFor(() => offerEvents.length >= 1, 30_000);
    expect(offerEvents).toHaveLength(1);
    const [offerRow] = await h.db.select().from(schema.historyOffers).where(eq(schema.historyOffers.id, offerEvents[0].offerId));
    expect(offerRow).toBeDefined();
    expect(offerRow.accountId).toBe(bobId);
    expect(offerRow.donorInstanceId).toBe(bobIos.client.instanceId);
    expect(offerRow.recipientInstanceId).toBe(bobDesktop.client.instanceId);
    expect(offerRow.manifest.kind).toBe("transfer");
    expect(offerRow.manifest.conversationCount).toBe(1);
    expect(offerRow.manifest.chunkBlobIds).toEqual(offerRow.chunkBlobIds);
    expect(offerRow.chunkBlobIds.length).toBeGreaterThanOrEqual(1);

    // The recipient verifies the donor against the enrollment chain and accepts on its own.
    await waitFor(() => texts(bobDesktop.client.messages.timeline(conv.id)).length >= 6, 30_000);
    await waitFor(() => bobDesktop.client.history.progress().phase === "idle");
    expect(texts(bobDesktop.client.messages.timeline(conv.id))).toEqual(messages);
    expect(phases.has("downloading") || phases.has("importing")).toBe(true);
    for (const item of bobDesktop.client.messages.timeline(conv.id)) {
      expect(item.seq, "a transferred item is a server event, not a local echo").not.toBeNull();
    }
    const own = bobDesktop.client.messages.timeline(conv.id).find((i) => i.content.kind === "text" && i.content.body === messages[1])!;
    expect(own.isOwn).toBe(true);
    expect(own.senderInstanceId).toBe(bobIos.client.instanceId);
    const media = mediaOf(bobDesktop, conv.id);
    expect(media.caption).toBe(caption);
    expect(media.thumbnail).toMatchObject({ width: 8, height: 6 });
    expect(media.thumbnail!.ref.blobId).not.toBe(media.ref.blobId);
    expect(eq8(await bobDesktop.client.media.download(media.ref), MEDIA)).toBe(true);
    expect(eq8(await bobDesktop.client.media.download(media.thumbnail!.ref), THUMB)).toBe(true);

    // Server side: consumed, chunks dated for the collector, and nothing readable anywhere in the offer.
    // (`accept` reports idle once the import is done and consumes AFTER that, so the local
    // listing empties a request later than the timeline fills.)
    await waitFor(async () => {
      const [row] = await h.db.select().from(schema.historyOffers).where(eq(schema.historyOffers.id, offerRow.id));
      return row.status === "consumed";
    });
    await waitFor(() => bobDesktop.client.history.pendingOffers().length === 0);
    const [consumed] = await h.db.select().from(schema.historyOffers).where(eq(schema.historyOffers.id, offerRow.id));
    expect(consumed.consumedAt).not.toBeNull();
    const chunks = await chunkBlobs(consumed.chunkBlobIds);
    for (const chunk of chunks) {
      expect(chunk.expiresAt, `chunk ${chunk.id} released after consumption`).not.toBeNull();
      expect(chunk.expiresAt!.getTime()).toBeGreaterThan(Date.now());
    }
    const searchable = [...chunks.map((c) => c.data), Buffer.from(JSON.stringify(consumed.manifest)), Buffer.from(consumed.sealedKey), Buffer.from(consumed.manifestSignature)];
    for (const text of [...messages, caption]) expect(anyContains(searchable, text), `offer material contains "${text}"`).toBe(false);
    expect(anyContains(searchable, "conversations"), "the archive's field names are not visible either").toBe(false);
    // Control: the same search finds a text planted among the same buffers.
    expect(anyContains([...searchable, Buffer.from(`x${messages[0]}x`)], messages[0])).toBe(true);

    // The desktop also joined the live group: what comes next reaches it through MLS, and nothing is offered twice.
    await waitJoined(bobDesktop, conv.id);
    const seven = h.unique("message 7");
    await alice.client.messages.send(conv.id, seven);
    await waitForText(bobDesktop, conv.id, seven);
    await waitForText(bobIos, conv.id, seven);
    await bobIos.client.sync.now();
    await bobDesktop.client.sync.now();
    const offers = await h.db.select().from(schema.historyOffers).where(eq(schema.historyOffers.recipientInstanceId, bobDesktop.client.instanceId!));
    expect(offers).toHaveLength(1);
    expect(offerEvents).toHaveLength(1);
    expect(new Set(bobDesktop.client.messages.timeline(conv.id).map((i) => i.id)).size).toBe(bobDesktop.client.messages.timeline(conv.id).length);

    await stopAll(alice, bobIos, bobDesktop);
  }, 120_000);
});

describe("backup and recovery", () => {
  it("enable → refresh → every device lost → a fresh install restores with the phrase; a wrong phrase downloads nothing; disable releases everything", async () => {
    const { aliceId, alice, bobIos, conv, messages, caption } = await seedDm();

    await alice.client.backup.refreshStatus();
    expect(alice.client.backup.status().remote).toEqual({ exists: false, updatedAt: null });
    const phrase = await alice.client.backup.enable();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(validateRecoveryPhrase(phrase)).toBe(true);
    await expect(alice.client.backup.enable()).rejects.toThrow(/already enabled/);
    const status = alice.client.backup.status();
    expect(status).toMatchObject({ enabled: true, busy: false, remote: { exists: true } });
    expect(status.lastBackupAt).not.toBeNull();

    // The row, the chunks (retained: undated), and no plaintext in either.
    const [first] = await h.db.select().from(schema.accountBackups).where(eq(schema.accountBackups.accountId, aliceId));
    expect(first).toBeDefined();
    expect(first.instanceId).toBe(alice.client.instanceId);
    expect(first.manifest.kind).toBe("backup");
    expect(first.manifest.conversationCount).toBe(1);
    expect(first.manifest.eventCount).toBeGreaterThanOrEqual(7);
    expect(first.chunkBlobIds).toEqual(first.manifest.chunkBlobIds);
    const firstChunks = await chunkBlobs(first.chunkBlobIds);
    for (const chunk of firstChunks) expect(chunk.expiresAt).toBeNull();
    const firstMaterial = [...firstChunks.map((c) => c.data), Buffer.from(JSON.stringify(first.manifest)), Buffer.from(first.keyCheck)];
    for (const text of [...messages, caption]) expect(anyContains(firstMaterial, text), `backup material contains "${text}"`).toBe(false);
    // Neither the phrase nor the derived key is in storage; the key is in the secret store only.
    const key = await alice.secrets.get(backupKeyName(aliceId, "allo"));
    expect(key?.length).toBe(32);
    expect(Buffer.from(alice.storage.dump()).includes(Buffer.from(phrase))).toBe(false);
    expect(Buffer.from(alice.storage.dump()).includes(Buffer.from(key!))).toBe(false);

    // More history, then a refresh: the new chunks are retained, the replaced ones dated.
    const afterBackup = h.unique("after backup");
    await alice.client.messages.send(conv.id, afterBackup);
    await waitForText(bobIos, conv.id, afterBackup);
    await alice.client.backup.refresh();
    const [second] = await h.db.select().from(schema.accountBackups).where(eq(schema.accountBackups.accountId, aliceId));
    expect(second.chunkBlobIds).not.toEqual(first.chunkBlobIds);
    expect(second.manifest.eventCount).toBeGreaterThan(first.manifest.eventCount);
    for (const chunk of await chunkBlobs(first.chunkBlobIds)) expect(chunk.expiresAt, "replaced chunk dated").not.toBeNull();
    for (const chunk of await chunkBlobs(second.chunkBlobIds)) expect(chunk.expiresAt, "live chunk undated").toBeNull();

    // Every device lost: the phone revokes itself and is wiped. The next registration bootstraps as active.
    await alice.client.instance.revoke(alice.client.instanceId!);
    await waitFor(() => alice.client.instance.state() === "revoked");
    await alice.client.stop();
    let blobGets = 0;
    const countingFetch: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? "GET").toUpperCase() === "GET" && /\/v1\/blobs\//.test(url)) blobGets += 1;
      return fetch(input, init);
    };
    const fresh = await h.makeClient(aliceId, "Alice new phone", "ios", { transport: { fetch: countingFetch } });
    expect(fresh.client.instance.state()).toBe("active");
    expect(fresh.client.instanceId).not.toBe(alice.client.instanceId);
    expect(fresh.client.messages.timeline(conv.id)).toEqual([]);
    await fresh.client.backup.refreshStatus();
    expect(fresh.client.backup.status().remote).toEqual({ exists: true, updatedAt: second.updatedAt.toISOString() });

    // A wrong phrase — well-formed or not — is refused by `keyCheck` before a single chunk is fetched.
    const mark = logMark();
    const wrong = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    expect(validateRecoveryPhrase(wrong)).toBe(true);
    await expect(fresh.client.backup.restore(wrong)).rejects.toBeInstanceOf(RecoveryPhraseError);
    await expect(fresh.client.backup.restore("not twelve words")).rejects.toBeInstanceOf(RecoveryPhraseError);
    expect(blobGets).toBe(0);
    expect(requestLog(mark).filter((r) => r.route === "/v1/blobs/:id")).toEqual([]);
    expect(requestLog(mark).filter((r) => r.method === "GET" && r.route === "/v1/accounts/me/backup").length).toBeGreaterThanOrEqual(1);
    expect(fresh.client.backup.status().enabled).toBe(false);

    // The right phrase, in any case: the whole timeline is back, the picture and its thumbnail open.
    await fresh.client.backup.restore(phrase.toUpperCase());
    expect(blobGets).toBe(second.chunkBlobIds.length);
    expect(texts(fresh.client.messages.timeline(conv.id))).toEqual([...messages, afterBackup]);
    expect(fresh.client.messages.timeline(conv.id).find((i) => i.content.kind === "text" && i.content.body === messages[0])?.isOwn).toBe(true);
    expect(fresh.client.messages.timeline(conv.id).find((i) => i.content.kind === "text" && i.content.body === messages[1])?.isOwn).toBe(false);
    const media = mediaOf(fresh, conv.id);
    expect(eq8(await fresh.client.media.download(media.ref), MEDIA)).toBe(true);
    expect(eq8(await fresh.client.media.download(media.thumbnail!.ref), THUMB)).toBe(true);
    expect(fresh.client.backup.status()).toMatchObject({ enabled: true, lastBackupAt: second.updatedAt.toISOString() });

    // The restored device carries on as the writer.
    await fresh.client.backup.refresh();
    const [third] = await h.db.select().from(schema.accountBackups).where(eq(schema.accountBackups.accountId, aliceId));
    expect(third.instanceId).toBe(fresh.client.instanceId);
    for (const chunk of await chunkBlobs(second.chunkBlobIds)) expect(chunk.expiresAt).not.toBeNull();

    // Disable: the row is gone, its chunks dated, the key forgotten; a later restore finds nothing.
    await fresh.client.backup.disable();
    expect(await h.db.select().from(schema.accountBackups).where(eq(schema.accountBackups.accountId, aliceId))).toEqual([]);
    for (const chunk of await chunkBlobs(third.chunkBlobIds)) expect(chunk.expiresAt).not.toBeNull();
    expect(await fresh.secrets.get(backupKeyName(aliceId, "allo"))).toBeUndefined();
    expect(fresh.client.backup.status()).toMatchObject({ enabled: false, remote: { exists: false } });
    await fresh.client.backup.disable(); // idempotent: the server's 404 is swallowed
    await expect(fresh.client.backup.restore(phrase)).rejects.toThrow(/not found/);

    await stopAll(bobIos, fresh);
  }, 120_000);
});

describe("delivered receipts", () => {
  it("Alice's message becomes `delivered` once Bob's client has it and `read` once he reads; the receipt is MLS ciphertext the server cannot tell from a message", async () => {
    const aliceId = h.account("alice");
    const bobId = h.account("bob");
    const alice = await h.makeClient(aliceId, "Alice", "web");
    const bob = await h.makeClient(bobId, "Bob", "ios");
    const conv = await alice.client.conversations.createDirect(bobId);
    await waitJoined(bob, conv.id);

    const hello = h.unique("hello");
    const localKey = await alice.client.messages.send(conv.id, hello);
    const item = () => alice.client.messages.timeline(conv.id).find((i) => i.localKey === localKey || (i.content.kind === "text" && i.content.body === hello));
    await waitForText(bob, conv.id, hello);
    await waitFor(() => item()?.sendState === "delivered", 20_000);
    await bob.client.messages.markRead(conv.id);
    await waitFor(() => item()?.sendState === "read", 20_000);

    // Bob sent no message, so every app_message of his is a receipt: opaque bytes, no kind, no reference in the clear.
    const events = await h.db
      .select()
      .from(schema.conversationEvents)
      .where(and(eq(schema.conversationEvents.conversationId, conv.id), eq(schema.conversationEvents.kind, "app_message")));
    const receipts = events.filter((e) => e.senderInstanceId === bob.client.instanceId);
    expect(receipts.length).toBeGreaterThanOrEqual(1);
    const payloads = events.map((e) => Buffer.from(e.payload));
    for (const needle of ["delivered", "upTo", "read", hello]) expect(anyContains(payloads, needle), `a payload contains "${needle}"`).toBe(false);
    expect(anyContains([...payloads, Buffer.from('{"t":"delivered"}')], "delivered")).toBe(true); // control
    // The server records the receipt as an ordinary app message: same kind, same shape, addressed to every other leaf.
    const deliveries = await h.db.select().from(schema.instanceDeliveries).where(eq(schema.instanceDeliveries.eventId, receipts[0].id));
    expect(deliveries.map((d) => d.instanceId)).toEqual([alice.client.instanceId]);

    await stopAll(alice, bob);
  }, 60_000);
});

describe("transfer keys", () => {
  it("registration without a transfer key is refused by the contract, every SDK-registered instance carries one, and a Phase 2 row is upgraded through PUT /v1/instances/me/transfer-key on start", async () => {
    const bobId = h.account("bob");
    // The contract: `transferPublicKey` is required on `POST /v1/instances`.
    const res = await fetch(`${h.baseUrl}/v1/instances`, {
      method: "POST",
      headers: { authorization: `Bearer test:${bobId}`, "content-type": "application/json" },
      body: JSON.stringify({ appId: "allo", platform: "ios", displayName: "raw", signingPublicKey: Buffer.alloc(32, 1).toString("base64") }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_failed");
    expect(await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.accountId, bobId))).toEqual([]);

    // The upgrade path: a row registered before the field existed is `null`; the SDK notices on start and publishes its key.
    const bob = await h.makeClient(bobId, "Bob", "ios");
    const id = bob.client.instanceId!;
    const [row] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, id));
    const key = row.transferPublicKey!;
    expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    await bob.client.stop();
    await h.db.update(schema.clientInstances).set({ transferPublicKey: null }).where(eq(schema.clientInstances.id, id));
    const mark = logMark();
    const again = await h.makeClient(bobId, "Bob", "ios", { storage: bob.storage, secrets: bob.secrets });
    expect(again.client.instanceId).toBe(id);
    await waitFor(async () => {
      const [r] = await h.db.select().from(schema.clientInstances).where(eq(schema.clientInstances.id, id));
      return r.transferPublicKey === key;
    });
    const puts = requestLog(mark).filter((r) => r.method === "PUT" && r.route === "/v1/instances/me/transfer-key");
    expect(puts).toHaveLength(1);
    expect(puts[0].status).toBe(200);
    await waitFor(() => again.client.instance.current()?.transferPublicKey === key);
    // The X25519 secret lives in the secret store and never reaches storage.
    const secret = await again.secrets.get(transferKeyName(bobId, "allo"));
    expect(secret?.length).toBe(32);
    expect(Buffer.from(again.storage.dump()).includes(Buffer.from(secret!))).toBe(false);
    await stopAll(again);

    // Every instance this suite registered through the SDK has a transfer key.
    const rows = await h.db.select().from(schema.clientInstances);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(await h.db.select({ id: schema.clientInstances.id }).from(schema.clientInstances).where(isNull(schema.clientInstances.transferPublicKey))).toEqual([]);
    for (const r of rows) expect(r.transferPublicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  }, 60_000);
});

describe("plaintext", () => {
  it("no event payload, blob, offer or backup on the server contains the text of any message sent above", async () => {
    expect(h.sent.length).toBeGreaterThanOrEqual(16);
    const offers = await h.db.select().from(schema.historyOffers);
    const backups = await h.db.select().from(schema.accountBackups);
    const material = [
      ...(await h.allPayloads()),
      ...(await h.allBlobBytes()),
      ...offers.flatMap((o) => [Buffer.from(JSON.stringify(o.manifest)), Buffer.from(o.sealedKey), Buffer.from(o.manifestSignature)]),
      ...backups.flatMap((b) => [Buffer.from(JSON.stringify(b.manifest)), Buffer.from(b.keyCheck), Buffer.from(b.manifestSignature)]),
    ];
    expect(offers.length).toBeGreaterThanOrEqual(1);
    expect(material.length).toBeGreaterThan(h.sent.length);
    for (const text of h.sent) expect(anyContains(material, text), `server material contains "${text}"`).toBe(false);
    for (const plain of [MEDIA, THUMB]) expect(material.some((m) => m.includes(Buffer.from(plain.subarray(0, 64))))).toBe(false);
    // Control: the search finds a planted copy.
    expect(anyContains([...material, Buffer.from(`>${h.sent[0]}<`)], h.sent[0])).toBe(true);
  });
});
