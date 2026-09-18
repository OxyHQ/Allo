import { describe, expect, it } from "vitest";
import { HISTORY_KEY_SEAL_INFO, archiveManifestMessage, type ArchiveManifest, type HistoryOffer } from "@allo/shared-types";
import { fakeServer, makeClient, stopAll, texts, waitFor, waitForText, waitJoined, type TestClient } from "./e2eHelpers";
import { generateArchiveKey, encryptArchive } from "../crypto/archive";
import { generateSigningKey, publicKeyBase64, signRequest, signUtf8, signingKeyFromSecret } from "../crypto/signing";
import { sealTo } from "../crypto/transfer";
import { validateRecoveryPhrase } from "../crypto/backupKey";
import { backupDue } from "../backup/service";
import { RecoveryPhraseError, UntrustedInstanceError } from "../errors";
import { project } from "../messages/projection";
import type { EventRecord } from "../storage/records";
import { MemorySecrets, MemoryStorage } from "../testing/memoryAdapters";
import { base64Decode, base64Encode, bytesEqual, bytesInclude, sha256Hex, utf8Encode } from "../util/bytes";
import { sleep } from "../util/async";

const MEDIA = new Uint8Array(3000).map((_, i) => (i * 13) & 0xff);
const THUMB = new Uint8Array(200).map((_, i) => (i * 7 + 3) & 0xff);

/** Alice ↔ Bob-ios DM with three texts, one media (with a thumbnail) and a read receipt. */
async function seededDm(server = fakeServer()) {
  const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
  const bobIos = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
  const conv = await alice.client.conversations.createDirect("acc-bob-0001");
  await waitJoined(bobIos, conv.id);
  await alice.client.messages.send(conv.id, "one");
  await bobIos.client.messages.send(conv.id, "two");
  await alice.client.messages.send(conv.id, "three");
  await waitForText(bobIos, conv.id, "three");
  await waitForText(alice, conv.id, "two");
  await alice.client.media.upload(conv.id, MEDIA, { kind: "image", filename: "pic.png", mime: "image/png", width: 40, height: 30, thumbnail: { bytes: THUMB, mime: "image/jpeg", width: 8, height: 6 } });
  await waitFor(() => bobIos.client.messages.timeline(conv.id).some((i) => i.content.kind === "media"));
  await alice.client.conversations.rename(conv.id, "A and B");
  await waitFor(() => bobIos.client.conversations.get(conv.id)?.title === "A and B");
  await bobIos.client.messages.markRead(conv.id);
  await bobIos.client.sync.flush();
  return { server, alice, bobIos, conv };
}

function mediaOf(c: TestClient, conversationId: string) {
  const item = c.client.messages.timeline(conversationId).find((i) => i.content.kind === "media")!;
  return (item.content as Extract<typeof item.content, { kind: "media" }>).media;
}

/** A signed request straight at the fake server, for rules the SDK refuses to break on its own. */
async function signedFetch(server: ReturnType<typeof fakeServer>, c: TestClient, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown) {
  const key = signingKeyFromSecret((await c.secrets.get(`allo.instance-key.${c.accountId}.allo`))!);
  const text = body === undefined ? undefined : JSON.stringify(body);
  const timestampMs = Date.now();
  const sig = signRequest(key, { method, pathWithQuery: path, timestampMs, bodySha256Hex: sha256Hex(utf8Encode(text ?? "")) });
  return server.fetch(`${server.baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer fake-token:${c.accountId}`,
      "x-allo-instance": c.client.instanceId!,
      "x-allo-timestamp": String(timestampMs),
      "x-allo-signature": sig,
      ...(text ? { "content-type": "application/json" } : {}),
    },
    body: text,
  });
}

describe("history transfer between instances of one account", () => {
  it("(t1) a newly approved device receives the full timeline from the elector, can open the media and its thumbnail, and the server saw ciphertext only", async () => {
    const { server, alice, bobIos, conv } = await seededDm();
    const bobDesktop = await makeClient(server, "acc-bob-0001", "Bob desktop", "desktop");
    expect(bobDesktop.client.instance.current()?.transferPublicKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    let historyEmits = 0;
    bobDesktop.client.subscribe("history", () => historyEmits++);
    const idle = bobDesktop.client.history.progress();
    expect(idle).toEqual({ phase: "idle", done: 0, total: 0 });
    expect(bobDesktop.client.history.progress()).toBe(idle); // stable while nothing happens

    await bobIos.client.instance.refreshPending();
    await bobIos.client.instance.approve(bobDesktop.client.instanceId!);
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    // the elector offers once, the recipient verifies and accepts on its own
    await waitForText(bobDesktop, conv.id, "one", 15_000);
    // the elector adds the new leaf on its next sync once the desktop has key packages up (the test interval is 60 s)
    await waitFor(() => (server.keyPackages.get(bobDesktop.client.instanceId!)?.length ?? 0) > 0);
    await bobIos.client.sync.now();
    await waitFor(() => bobDesktop.client.history.progress().phase === "idle");
    expect(texts(bobDesktop.client.messages.timeline(conv.id))).toEqual(["one", "two", "three"]);
    expect(historyEmits).toBeGreaterThan(0);
    const own = bobDesktop.client.messages.timeline(conv.id).find((i) => i.content.kind === "text" && i.content.body === "two")!;
    expect(own.isOwn).toBe(true); // Bob's own message, sent from the other device
    expect(bobDesktop.client.conversations.get(conv.id)?.title).toBe("A and B");
    expect(bobDesktop.client.conversations.get(conv.id)?.unreadCount).toBe(0); // Bob's own read receipt travelled with the archive
    // media and its thumbnail open on the new device
    const media = mediaOf(bobDesktop, conv.id);
    expect(media.thumbnail).toBeDefined();
    expect(media.thumbnail?.width).toBe(8);
    expect(bytesEqual(await bobDesktop.client.media.download(media.ref), MEDIA)).toBe(true);
    expect(bytesEqual(await bobDesktop.client.media.download(media.thumbnail!.ref), THUMB)).toBe(true);
    // one offer, consumed; the archive chunks never carried plaintext, and the sealed key never carried the archive key
    const offers = [...server.historyOffers.values()];
    expect(offers).toHaveLength(1);
    expect(offers[0].status).toBe("consumed");
    expect(offers[0].donorInstanceId).toBe(bobIos.client.instanceId);
    expect(offers[0].recipientInstanceId).toBe(bobDesktop.client.instanceId);
    for (const id of offers[0].manifest.chunkBlobIds) {
      const blob = server.blobs.get(id)!;
      expect(bytesInclude(blob.bytes, utf8Encode("one"))).toBe(false);
      expect(bytesInclude(blob.bytes, utf8Encode("A and B"))).toBe(false);
      expect(bytesInclude(blob.bytes, utf8Encode("acc-bob-0001"))).toBe(false);
      expect(blob.expiresAt).not.toBeNull(); // released once consumed
    }
    // the new device also joined the live group and reads what comes next; nothing was offered twice
    await waitJoined(bobDesktop, conv.id, 10_000);
    await alice.client.messages.send(conv.id, "four");
    await waitForText(bobDesktop, conv.id, "four");
    await bobIos.client.sync.now();
    await bobDesktop.client.sync.now();
    expect([...server.historyOffers.values()]).toHaveLength(1);
    // the recipient's timeline does not show the transferred items as local echoes and holds each event once
    expect(bobDesktop.client.messages.timeline(conv.id).filter((i) => i.seq === null)).toHaveLength(0);
    expect(new Set(bobDesktop.client.messages.timeline(conv.id).map((i) => i.id)).size).toBe(bobDesktop.client.messages.timeline(conv.id).length);
    await stopAll(alice, bobIos, bobDesktop);
  });

  it("(t2) an offer with a forged manifest signature, or from a donor that is not a verified same-account instance, is refused before any download", async () => {
    const { server, alice, bobIos, conv } = await seededDm();
    // A second, legitimately approved device to be the recipient; its own transfer completes first.
    const bobDesktop = await makeClient(server, "acc-bob-0001", "Bob desktop", "desktop");
    await bobIos.client.instance.refreshPending();
    await bobIos.client.instance.approve(bobDesktop.client.instanceId!);
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    await waitForText(bobDesktop, conv.id, "three", 15_000);
    await waitFor(() => [...server.historyOffers.values()].every((o) => o.status !== "pending"));

    const recipient = server.instances.get(bobDesktop.client.instanceId!)!;
    const plant = async (donorId: string, signWith: ReturnType<typeof generateSigningKey>, tag: string): Promise<{ offer: HistoryOffer; chunkIds: string[] }> => {
      const key = generateArchiveKey();
      const chunks = encryptArchive(key, utf8Encode(`{"planted":"${tag}"}`));
      const chunkIds = chunks.map((c, i) => {
        const id = `planted-${tag}-${i}-0000000000000000000000000000000000000000000000`.slice(0, 64);
        server.blobs.set(id, { bytes: c, sha256: sha256Hex(c), uploaderInstanceId: donorId, accountId: "acc-bob-0001", expiresAt: null });
        return id;
      });
      const manifest: ArchiveManifest = { v: 1, kind: "transfer", createdAt: new Date().toISOString(), conversationCount: 1, eventCount: 1, chunkBlobIds: chunkIds, plaintextSha256: sha256Hex(utf8Encode("x")) };
      const offer: HistoryOffer = {
        id: `offer-${tag}-00000000`,
        accountId: "acc-bob-0001",
        donorInstanceId: donorId,
        recipientInstanceId: recipient.id,
        manifest,
        sealedKey: base64Encode(await sealTo(base64Decode(recipient.transferPublicKey!), key, HISTORY_KEY_SEAL_INFO)),
        manifestSignature: signUtf8(signWith, archiveManifestMessage(manifest)),
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      };
      server.historyOffers.set(offer.id, offer);
      return { offer, chunkIds };
    };
    // (1) the real donor, but a signature by somebody else
    const forged = await plant(bobIos.client.instanceId!, generateSigningKey(), "forged");
    // (2) a planted second "bootstrap root" on Bob's account: active, unapproved, refused by the chain; signs its own manifest correctly
    const plantedKey = generateSigningKey();
    const planted = server.injectInstance({ accountId: "acc-bob-0001", signingPublicKey: publicKeyBase64(plantedKey), approvedByInstanceId: null, transferPublicKey: base64Encode(new Uint8Array(32)) });
    const untrusted = await plant(planted.id, plantedKey, "root2");
    // (3) another account's instance as donor, correctly signed by that instance
    const aliceKey = signingKeyFromSecret((await alice.secrets.get("allo.instance-key.acc-alice-01.allo"))!);
    const foreign = await plant(alice.client.instanceId!, aliceKey, "alice");

    server.requestLog.length = 0;
    await bobDesktop.client.history.refreshOffers();
    const views = bobDesktop.client.history.pendingOffers();
    expect(views.map((v) => v.id).sort()).toEqual([forged.offer.id, untrusted.offer.id, foreign.offer.id].sort());
    expect(views.every((v) => v.trusted === false)).toBe(true);
    expect(bobDesktop.client.history.pendingOffers()).toBe(views); // stable
    await expect(bobDesktop.client.history.accept(forged.offer.id)).rejects.toBeInstanceOf(UntrustedInstanceError);
    await expect(bobDesktop.client.history.accept(forged.offer.id)).rejects.toThrow(/signature/);
    await expect(bobDesktop.client.history.accept(untrusted.offer.id)).rejects.toBeInstanceOf(UntrustedInstanceError);
    await expect(bobDesktop.client.history.accept(foreign.offer.id)).rejects.toBeInstanceOf(UntrustedInstanceError);
    // the automatic path leaves them alone too
    await bobDesktop.client.sync.now();
    await sleep(100);
    for (const p of [forged, untrusted, foreign]) {
      expect(server.historyOffers.get(p.offer.id)!.status).toBe("pending");
      for (const id of p.chunkIds) expect(server.requestLog.some((r) => r.path === `/v1/blobs/${id}`)).toBe(false);
    }
    expect(texts(bobDesktop.client.messages.timeline(conv.id))).toEqual(["one", "two", "three"]);
    await stopAll(alice, bobIos, bobDesktop);
  });

  it("(t3) the fake server enforces the offer rules: same account, transfer key present, valid signature, one pending offer per pair", async () => {
    const { server, alice, bobIos } = await seededDm();
    const bobDesktop = await makeClient(server, "acc-bob-0001", "Bob desktop", "desktop");
    await bobIos.client.instance.refreshPending();
    await bobIos.client.instance.approve(bobDesktop.client.instanceId!);
    await waitFor(() => bobDesktop.client.instance.state() === "active");
    await waitFor(() => [...server.historyOffers.values()].some((o) => o.recipientInstanceId === bobDesktop.client.instanceId && o.status === "consumed"), 15_000);
    const bobKey = signingKeyFromSecret((await bobIos.secrets.get("allo.instance-key.acc-bob-0001.allo"))!);
    const chunk = encryptArchive(generateArchiveKey(), utf8Encode("{}"))[0];
    const up = await signedFetch(server, bobIos, "POST", "/v1/blobs"); // bodyless: fails digest, we only need a real upload below
    expect(up.status).toBe(400);
    const blobId = [...server.blobs.entries()].find(([, b]) => b.uploaderInstanceId === bobIos.client.instanceId)![0];
    const manifest: ArchiveManifest = { v: 1, kind: "transfer", createdAt: new Date().toISOString(), conversationCount: 0, eventCount: 0, chunkBlobIds: [blobId], plaintextSha256: sha256Hex(chunk) };
    const good = { manifest, sealedKey: base64Encode(new Uint8Array(80)), manifestSignature: signUtf8(bobKey, archiveManifestMessage(manifest)) };
    const desktopId = bobDesktop.client.instanceId!;
    // another account's instance as recipient → 404
    let res = await signedFetch(server, bobIos, "POST", `/v1/instances/${alice.client.instanceId}/history-offers`, { recipientInstanceId: alice.client.instanceId, ...good });
    expect(res.status).toBe(404);
    // recipient without a transfer key → 409 transfer_key_missing
    const saved = server.instances.get(desktopId)!.transferPublicKey;
    server.instances.get(desktopId)!.transferPublicKey = null;
    res = await signedFetch(server, bobIos, "POST", `/v1/instances/${desktopId}/history-offers`, { recipientInstanceId: desktopId, ...good });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("transfer_key_missing");
    server.instances.get(desktopId)!.transferPublicKey = saved;
    // forged signature → 401
    res = await signedFetch(server, bobIos, "POST", `/v1/instances/${desktopId}/history-offers`, { recipientInstanceId: desktopId, ...good, manifestSignature: signUtf8(generateSigningKey(), archiveManifestMessage(manifest)) });
    expect(res.status).toBe(401);
    // a backup manifest cannot be offered
    res = await signedFetch(server, bobIos, "POST", `/v1/instances/${desktopId}/history-offers`, { recipientInstanceId: desktopId, ...good, manifest: { ...manifest, kind: "backup" } });
    expect(res.status).toBe(400);
    // a chunk of another account → 404
    const aliceBlob = [...server.blobs.entries()].find(([, b]) => b.accountId === "acc-alice-01")![0];
    const stolen: ArchiveManifest = { ...manifest, chunkBlobIds: [aliceBlob] };
    res = await signedFetch(server, bobIos, "POST", `/v1/instances/${desktopId}/history-offers`, { recipientInstanceId: desktopId, ...good, manifest: stolen, manifestSignature: signUtf8(bobKey, archiveManifestMessage(stolen)) });
    expect(res.status).toBe(404);
    // two valid offers: the newer replaces the older
    res = await signedFetch(server, bobIos, "POST", `/v1/instances/${desktopId}/history-offers`, { recipientInstanceId: desktopId, ...good });
    expect(res.status).toBe(201);
    const first = (await res.json()).offer.id as string;
    res = await signedFetch(server, bobIos, "POST", `/v1/instances/${desktopId}/history-offers`, { recipientInstanceId: desktopId, ...good });
    expect(res.status).toBe(201);
    const second = (await res.json()).offer.id as string;
    expect(server.historyOffers.get(first)!.status).toBe("expired");
    expect(server.historyOffers.get(second)!.status).toBe("pending");
    expect(server.blobs.get(blobId)!.expiresAt).toBeNull(); // still referenced by the pending one
    // consume by somebody else than the recipient → 404
    res = await signedFetch(server, bobIos, "POST", `/v1/instances/me/history-offers/${second}/consume`);
    expect(res.status).toBe(404);
    // manual offer from the SDK to itself is refused; to an unknown instance is refused as untrusted
    await expect(bobIos.client.history.offerTo(bobIos.client.instanceId!)).rejects.toThrow(/itself/);
    await expect(bobIos.client.history.offerTo("nobody-000000")).rejects.toBeInstanceOf(UntrustedInstanceError);
    await stopAll(alice, bobIos, bobDesktop);
  });

  it("(t4) an instance registered before transfer keys existed uploads its key on start", async () => {
    const server = fakeServer();
    const storage = new MemoryStorage();
    const secrets = new MemorySecrets();
    const bob1 = await makeClient(server, "acc-bob-0001", "Bob", "ios", { storage, secrets });
    const id = bob1.client.instanceId!;
    const key = server.instances.get(id)!.transferPublicKey!;
    await bob1.client.stop();
    server.instances.get(id)!.transferPublicKey = null; // a Phase 2 row
    server.requestLog.length = 0;
    const bob2 = await makeClient(server, "acc-bob-0001", "Bob", "ios", { storage, secrets });
    // The server has the key as soon as the PUT handler runs; the client's own
    // record follows when the response is processed. Wait for the latter, or a
    // slow runner reads `current()` between the two (measured: green locally
    // three times, red on the first CI run).
    await waitFor(() => bob2.client.instance.current()?.transferPublicKey === key);
    expect(server.instances.get(id)!.transferPublicKey).toBe(key);
    expect(server.requestLog.filter((r) => r.method === "PUT" && r.path === "/v1/instances/me/transfer-key")).toHaveLength(1);
    // the raw transfer secret never reaches storage
    expect(bytesInclude(storage.dump(), (await secrets.get("allo.transfer-key.acc-bob-0001.allo"))!)).toBe(false);
    await stopAll(bob2);
  });
});

describe("backup and recovery", () => {
  it("(b1) enable → refresh → every device lost → fresh install restores with the phrase; a wrong phrase is refused before any download", async () => {
    const { server, alice, bobIos, conv } = await seededDm();
    let backupEmits = 0;
    alice.client.subscribe("backup", () => backupEmits++);
    const s0 = alice.client.backup.status();
    expect(s0).toEqual({ enabled: false, lastBackupAt: null, eventCount: 0, remote: null, busy: false });
    expect(alice.client.backup.status()).toBe(s0);
    await alice.client.backup.refreshStatus();
    expect(alice.client.backup.status().remote).toEqual({ exists: false, updatedAt: null });

    const phrase = await alice.client.backup.enable();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(validateRecoveryPhrase(phrase)).toBe(true);
    expect(backupEmits).toBeGreaterThan(0);
    const s1 = alice.client.backup.status();
    expect(s1.enabled).toBe(true);
    expect(s1.lastBackupAt).not.toBeNull();
    expect(s1.remote?.exists).toBe(true);
    expect(s1.busy).toBe(false);
    expect(s1.eventCount).toBeGreaterThan(0);
    await expect(alice.client.backup.enable()).rejects.toThrow(/already enabled/);
    // the phrase and the key are nowhere in storage; the key is in the secret store
    expect(bytesInclude(alice.storage.dump(), utf8Encode(phrase))).toBe(false);
    const key = (await alice.secrets.get("allo.backup-key.acc-alice-01.allo"))!;
    expect(key.length).toBe(32);
    expect(bytesInclude(alice.storage.dump(), key)).toBe(false);
    const backup = server.backups.get("acc-alice-01")!;
    expect(backup.manifest.kind).toBe("backup");
    for (const id of backup.manifest.chunkBlobIds) {
      expect(bytesInclude(server.blobs.get(id)!.bytes, utf8Encode("three"))).toBe(false);
      expect(server.blobs.get(id)!.expiresAt).toBeNull();
    }
    // more history, refresh replaces
    await alice.client.messages.send(conv.id, "after backup");
    await waitForText(bobIos, conv.id, "after backup");
    const firstChunks = backup.manifest.chunkBlobIds;
    await alice.client.backup.refresh();
    const second = server.backups.get("acc-alice-01")!;
    expect(second.manifest.chunkBlobIds).not.toEqual(firstChunks);
    for (const id of firstChunks) expect(server.blobs.get(id)!.expiresAt).not.toBeNull();

    // every device lost: the instance is revoked, the phone is wiped
    await alice.client.instance.revoke(alice.client.instanceId!);
    await alice.client.stop();
    const fresh = await makeClient(server, "acc-alice-01", "Alice new phone", "ios");
    expect(fresh.client.instance.state()).toBe("active"); // bootstrap again: no other active instance
    expect(texts(fresh.client.messages.timeline(conv.id))).toEqual([]);
    await fresh.client.backup.refreshStatus();
    expect(fresh.client.backup.status().remote).toEqual({ exists: true, updatedAt: second.updatedAt });

    server.requestLog.length = 0;
    const wrong = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    await expect(fresh.client.backup.restore(wrong)).rejects.toBeInstanceOf(RecoveryPhraseError);
    await expect(fresh.client.backup.restore("not twelve words")).rejects.toBeInstanceOf(RecoveryPhraseError);
    expect(server.requestLog.some((r) => r.path.startsWith("/v1/blobs/"))).toBe(false); // keyCheck refused it first
    expect(fresh.client.backup.status().enabled).toBe(false);

    await fresh.client.backup.restore(phrase.toUpperCase());
    expect(texts(fresh.client.messages.timeline(conv.id))).toEqual(["one", "two", "three", "after backup"]);
    expect(fresh.client.conversations.get(conv.id)?.title).toBe("A and B");
    expect(fresh.client.messages.timeline(conv.id).find((i) => i.content.kind === "text" && i.content.body === "one")?.isOwn).toBe(true);
    const media = mediaOf(fresh, conv.id);
    expect(bytesEqual(await fresh.client.media.download(media.ref), MEDIA)).toBe(true);
    expect(bytesEqual(await fresh.client.media.download(media.thumbnail!.ref), THUMB)).toBe(true);
    // restore keeps the key so refreshes continue from the new device
    const s2 = fresh.client.backup.status();
    expect(s2.enabled).toBe(true);
    expect(s2.lastBackupAt).toBe(second.updatedAt);
    await fresh.client.backup.refresh();
    expect(server.backups.get("acc-alice-01")!.instanceId).toBe(fresh.client.instanceId);
    // disable deletes and forgets
    await fresh.client.backup.disable();
    expect(server.backups.has("acc-alice-01")).toBe(false);
    expect(await fresh.secrets.get("allo.backup-key.acc-alice-01.allo")).toBeUndefined();
    expect(fresh.client.backup.status()).toMatchObject({ enabled: false, remote: { exists: false } });
    await fresh.client.backup.disable(); // idempotent
    await expect(fresh.client.backup.restore(phrase)).rejects.toThrow(/not found/);
    await stopAll(bobIos, fresh);
  });

  it("(b2) a backup written by an instance that is not the account's, or with a bad signature, is refused; the automatic refresh policy", async () => {
    const { server, alice, bobIos } = await seededDm();
    const phrase = await alice.client.backup.enable();
    const backup = server.backups.get("acc-alice-01")!;
    // tamper: the signature no longer matches
    const saved = backup.manifestSignature;
    backup.manifestSignature = signUtf8(generateSigningKey(), archiveManifestMessage(backup.manifest));
    await alice.client.instance.revoke(alice.client.instanceId!);
    await alice.client.stop();
    const fresh = await makeClient(server, "acc-alice-01", "Alice new", "ios");
    await expect(fresh.client.backup.restore(phrase)).rejects.toBeInstanceOf(UntrustedInstanceError);
    backup.manifestSignature = saved;
    // the writer is claimed to be another account's instance
    const writer = backup.instanceId;
    backup.instanceId = bobIos.client.instanceId!;
    await expect(fresh.client.backup.restore(phrase)).rejects.toBeInstanceOf(UntrustedInstanceError);
    backup.instanceId = writer;
    await fresh.client.backup.restore(phrase);
    expect(texts(fresh.client.messages.timeline([...server.conversations.keys()][0]))).toEqual(["one", "two", "three"]);
    // policy
    const at = Date.parse("2026-01-01T00:00:00.000Z");
    expect(backupDue({ enabled: false, lastBackupAt: null, eventCountAtBackup: 0 }, 100, at)).toBe(false);
    expect(backupDue({ enabled: true, lastBackupAt: null, eventCountAtBackup: 0 }, 0, at)).toBe(true);
    expect(backupDue({ enabled: true, lastBackupAt: "2026-01-01T00:00:00.000Z", eventCountAtBackup: 10 }, 29, at + 1000)).toBe(false);
    expect(backupDue({ enabled: true, lastBackupAt: "2026-01-01T00:00:00.000Z", eventCountAtBackup: 10 }, 30, at + 1000)).toBe(true);
    expect(backupDue({ enabled: true, lastBackupAt: "2026-01-01T00:00:00.000Z", eventCountAtBackup: 10 }, 10, at + 24 * 3600_000 + 1)).toBe(true);
    // the fake server: DELETE with no backup is 404 backup_not_found; GET is null
    await fresh.client.backup.disable();
    const res = await signedFetch(server, fresh, "DELETE", "/v1/accounts/me/backup");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("backup_not_found");
    await stopAll(bobIos, fresh);
  });

  it("(b3) the automatic refresh runs after a sync once 20 events landed, debounced", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bobStorage = new MemoryStorage();
    const bobSecrets = new MemorySecrets();
    const { createAlloClient } = await import("../client");
    const { FakeSession } = await import("../testing/memoryAdapters");
    const bobClient = createAlloClient({
      baseUrl: server.baseUrl,
      appId: "allo",
      platform: "ios",
      displayName: "Bob",
      session: FakeSession.for("acc-bob-0001"),
      storage: bobStorage,
      secrets: bobSecrets,
      transport: { fetch: server.fetch, socketFactory: server.socketFactory },
      syncIntervalMs: 60_000,
      keyPackageTarget: 6,
      backupDebounceMs: 20,
    });
    await bobClient.start();
    const bob: TestClient = { client: bobClient, storage: bobStorage, secrets: bobSecrets, accountId: "acc-bob-0001", name: "Bob" };
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    await bobClient.backup.enable();
    const first = server.backups.get("acc-bob-0001")!.updatedAt;
    const firstCount = bobClient.backup.status().eventCount;
    for (let i = 1; i <= 25; i++) await alice.client.messages.send(conv.id, `n${i}`);
    await waitForText(bob, conv.id, "n25", 15_000);
    await waitFor(() => bobClient.backup.status().eventCount >= firstCount + 20, 10_000);
    expect(server.backups.get("acc-bob-0001")!.updatedAt >= first).toBe(true);
    expect(server.backups.get("acc-bob-0001")!.manifest.eventCount).toBeGreaterThanOrEqual(25);
    await stopAll(alice, bob);
  });
});

describe("delivery receipts", () => {
  it("(d1) a message becomes `delivered` on the other account's receipt, `read` on its read receipt, and is never downgraded", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    const key = await alice.client.messages.send(conv.id, "hello");
    await waitForText(bob, conv.id, "hello");
    await waitFor(() => alice.client.messages.timeline(conv.id).find((i) => i.localKey === key)?.sendState === "delivered");
    // the receipt is an encrypted app message; the server saw no 'delivered' string
    for (const e of server.eventsOf(conv.id)) expect(bytesInclude(utf8Encode(e.payload), utf8Encode("delivered"))).toBe(false);
    await bob.client.messages.markRead(conv.id);
    await waitFor(() => alice.client.messages.timeline(conv.id).find((i) => i.localKey === key)?.sendState === "read");
    // a second message: bob's trailing delivered receipt for it must not move the first back to delivered
    const key2 = await alice.client.messages.send(conv.id, "again");
    await waitForText(bob, conv.id, "again");
    await waitFor(() => alice.client.messages.timeline(conv.id).find((i) => i.localKey === key2)?.sendState === "delivered", 10_000);
    expect(alice.client.messages.timeline(conv.id).find((i) => i.localKey === key)?.sendState).toBe("read");
    // throttled: 25 messages in a burst yield far fewer than 25 receipts from bob
    for (let i = 0; i < 25; i++) await alice.client.messages.send(conv.id, `burst ${i}`);
    await waitForText(bob, conv.id, "burst 24", 15_000);
    await bob.client.sync.flush();
    const bobReceipts = server.eventsOf(conv.id).filter((e) => e.kind === "app_message" && e.senderInstanceId === bob.client.instanceId);
    expect(bobReceipts.length).toBeLessThan(10);
    await stopAll(alice, bob);
  });

  it("(d2) projection: a delivered receipt from an own instance moves nothing; read wins over delivered", () => {
    const ev = (p: Partial<EventRecord> & Pick<EventRecord, "id" | "seq" | "senderAccountId" | "message">): EventRecord => ({
      conversationId: "c",
      kind: "app_message",
      epoch: 1,
      senderInstanceId: "i",
      createdAt: "2026-01-01T00:00:00.000Z",
      localKey: null,
      failure: null,
      system: null,
      ...p,
    });
    const upTo = (eventId: string) => ({ kind: "event" as const, conversationId: "c", eventId });
    const items = project({
      conversationId: "c",
      accountId: "me",
      instanceId: "i",
      outbox: [],
      events: [
        ev({ id: "e1", seq: 1, senderAccountId: "me", message: { v: 1, t: "text", body: "a" } }),
        ev({ id: "e2", seq: 2, senderAccountId: "me", message: { v: 1, t: "text", body: "b" } }),
        ev({ id: "e3", seq: 3, senderAccountId: "me", message: { v: 1, t: "text", body: "c" } }),
        ev({ id: "e4", seq: 4, senderAccountId: "me", senderInstanceId: "i2", message: { v: 1, t: "delivered", upTo: upTo("e3") } }), // own other device: ignored
        ev({ id: "e5", seq: 5, senderAccountId: "them", message: { v: 1, t: "delivered", upTo: upTo("e2") } }),
        ev({ id: "e6", seq: 6, senderAccountId: "them", message: { v: 1, t: "read", upTo: upTo("e1") } }),
        ev({ id: "e7", seq: 7, senderAccountId: "them", message: { v: 1, t: "delivered", upTo: upTo("e1") } }), // older than the read: no downgrade
      ],
    });
    expect(items.map((i) => [i.id, i.sendState])).toEqual([
      ["e1", "read"],
      ["e2", "delivered"],
      ["e3", "accepted"],
    ]);
  });
});

describe("thumbnails", () => {
  it("(m1) a media upload with a thumbnail sends two blobs; the receiver opens both; the message names the thumbnail", async () => {
    const { server, alice, bobIos, conv } = await seededDm();
    const media = mediaOf(bobIos, conv.id);
    expect(media.thumbnail).toEqual({ ref: { conversationId: conv.id, blobId: expect.any(String) }, width: 8, height: 6 });
    expect(media.thumbnail!.ref.blobId).not.toBe(media.ref.blobId);
    expect(bytesEqual(await bobIos.client.media.download(media.ref), MEDIA)).toBe(true);
    expect(bytesEqual(await bobIos.client.media.download(media.thumbnail!.ref), THUMB)).toBe(true);
    const event = server.eventsOf(conv.id).find((e) => e.blobIds.length === 2)!;
    expect(event.blobIds.sort()).toEqual([media.ref.blobId, media.thumbnail!.ref.blobId].sort());
    expect(bytesInclude(server.blobs.get(media.thumbnail!.ref.blobId)!.bytes, THUMB.subarray(0, 32))).toBe(false);
    // the sender opens both as well (its own keys are kept)
    expect(bytesEqual(await alice.client.media.download(mediaOf(alice, conv.id).thumbnail!.ref), THUMB)).toBe(true);
    await stopAll(alice, bobIos);
  });
});

