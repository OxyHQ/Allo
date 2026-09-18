/**
 * History offers, end to end against a real database with real keys: every
 * rule of `services/platform/historyService.ts`, the response shapes, the
 * `history.offer` nudge, and the chunk-blob retention transitions on create,
 * replace, consume, expiry and the sweep.
 */

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import {
  HISTORY_OFFER_TTL_MS,
  archiveManifestMessage,
  errorResponseSchema,
  historyOfferResponseSchema,
  listHistoryOffersResponseSchema,
  type ArchiveManifest,
} from "@allo/shared-types";
import * as schema from "../../db/schema";
import { runExpirySweep } from "../../db/expiry";
import { CHUNK_RELEASE_TTL_MS } from "../../db/platform/historyRepository";
import { runBlobGc } from "../../workers/blobGc";
import {
  accountId,
  base64,
  createPlatformHarness,
  dmBetween,
  expectParses,
  generateEd25519,
  signMessage,
  TestInstance,
  USER_HEADER,
  type PlatformHarness,
} from "./harness";

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

const silentLog = { info: () => undefined, debug: () => undefined };
const DAY_MS = 24 * 60 * 60 * 1_000;

/** Upload `count` throwaway chunk blobs from `who`. */
async function uploadChunks(who: TestInstance, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const response = await who.uploadBlob(randomBytes(48));
    if (response.status !== 201) throw new Error(`chunk upload failed: ${response.status}`);
    ids.push(response.body.blobId as string);
  }
  return ids;
}

function manifestFor(chunkBlobIds: string[], kind: ArchiveManifest["kind"] = "transfer"): ArchiveManifest {
  return {
    v: 1,
    kind,
    createdAt: new Date().toISOString(),
    conversationCount: 2,
    eventCount: 40,
    chunkBlobIds,
    plaintextSha256: randomBytes(32).toString("hex"),
  };
}

/** A complete, correctly signed offer body from `donor` to `recipient`. */
function offerBody(donor: TestInstance, recipient: TestInstance, manifest: ArchiveManifest) {
  return {
    recipientInstanceId: recipient.id,
    manifest,
    sealedKey: randomBytes(80).toString("base64"),
    manifestSignature: signMessage(donor.key, archiveManifestMessage(manifest)),
  };
}

async function expiresAtOf(blobIds: readonly string[]): Promise<Map<string, Date | null>> {
  const rows = await h.db
    .select({ id: schema.blobs.id, expiresAt: schema.blobs.expiresAt })
    .from(schema.blobs)
    .where(inArray(schema.blobs.id, [...blobIds]));
  return new Map(rows.map((row) => [row.id, row.expiresAt]));
}

async function offerStatus(id: string): Promise<string | undefined> {
  const [row] = await h.db.select({ status: schema.historyOffers.status }).from(schema.historyOffers).where(eq(schema.historyOffers.id, id));
  return row?.status;
}

/** `expires_at` within a minute of `now + ms`. */
function expectDatedAbout(date: Date | null | undefined, ms: number): void {
  expect(date).toBeInstanceOf(Date);
  expect(Math.abs((date as Date).getTime() - (Date.now() + ms))).toBeLessThan(60_000);
}

/** Two active instances of one account. */
async function twoDevices() {
  const account = accountId();
  const donor = await TestInstance.register(h.app, account);
  const recipient = await TestInstance.register(h.app, account, { platform: "ios" });
  await donor.approve(recipient);
  return { account, donor, recipient };
}

describe("POST /v1/instances/:id/history-offers", () => {
  it("creates a pending offer, retains the chunks and nudges the recipient", async () => {
    const { account, donor, recipient } = await twoDevices();
    const chunks = await uploadChunks(donor, 2);
    for (const date of (await expiresAtOf(chunks)).values()) expect(date).not.toBeNull();

    const body = offerBody(donor, recipient, manifestFor(chunks));
    const response = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, body);
    expect(response.status).toBe(201);
    const { offer } = expectParses(historyOfferResponseSchema, response.body);
    expect(offer.accountId).toBe(account);
    expect(offer.donorInstanceId).toBe(donor.id);
    expect(offer.recipientInstanceId).toBe(recipient.id);
    expect(offer.status).toBe("pending");
    expect(offer.manifest).toEqual(body.manifest);
    expect(offer.sealedKey).toBe(body.sealedKey);
    expect(offer.manifestSignature).toBe(body.manifestSignature);
    expect(Math.abs(new Date(offer.expiresAt).getTime() - (Date.now() + HISTORY_OFFER_TTL_MS))).toBeLessThan(60_000);

    for (const date of (await expiresAtOf(chunks)).values()) expect(date).toBeNull();
    expect(h.realtime.historyOffers).toEqual([{ instanceId: recipient.id, offerId: offer.id }]);
  });

  it("refuses a body whose recipient is not the instance in the path", async () => {
    const { donor, recipient } = await twoDevices();
    const chunks = await uploadChunks(donor, 1);
    const response = await donor.signed("post", `/v1/instances/${donor.id}/history-offers`, offerBody(donor, recipient, manifestFor(chunks)));
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("validation_failed");
  });

  it("same account only: another account's instance is not_found, and nothing is retained or nudged", async () => {
    const { donor } = await twoDevices();
    const stranger = await TestInstance.register(h.app, accountId("stranger"));
    const chunks = await uploadChunks(donor, 1);
    const response = await donor.signed("post", `/v1/instances/${stranger.id}/history-offers`, offerBody(donor, stranger, manifestFor(chunks)));
    expect(response.status).toBe(404);
    expect(expectParses(errorResponseSchema, response.body).error.code).toBe("not_found");
    for (const date of (await expiresAtOf(chunks)).values()) expect(date).not.toBeNull();
    expect(h.realtime.historyOffers).toEqual([]);
    expect(await h.db.select().from(schema.historyOffers).where(eq(schema.historyOffers.donorInstanceId, donor.id))).toHaveLength(0);
  });

  it("refuses an offer to itself, to a pending instance and to a revoked one", async () => {
    const { account, donor, recipient } = await twoDevices();
    const pending = await TestInstance.register(h.app, account, { platform: "android" });
    const chunks = await uploadChunks(donor, 1);

    const self = await donor.signed("post", `/v1/instances/${donor.id}/history-offers`, offerBody(donor, donor, manifestFor(chunks)));
    expect(self.status).toBe(400);

    const toPending = await donor.signed("post", `/v1/instances/${pending.id}/history-offers`, offerBody(donor, pending, manifestFor(chunks)));
    expect(toPending.status).toBe(403);
    expect(toPending.body.error.code).toBe("instance_not_active");

    await donor.signed("post", `/v1/instances/${recipient.id}/revoke`).expect(200);
    const toRevoked = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(chunks)));
    expect(toRevoked.status).toBe(403);
    expect(toRevoked.body.error.code).toBe("instance_revoked");
  });

  it("refuses a recipient without a transfer key with 409 transfer_key_missing", async () => {
    const { donor, recipient } = await twoDevices();
    // A Phase 2 row: registered before the column existed.
    await h.db.update(schema.clientInstances).set({ transferPublicKey: null }).where(eq(schema.clientInstances.id, recipient.id));
    const chunks = await uploadChunks(donor, 1);
    const response = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(chunks)));
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("transfer_key_missing");

    // Publishing the key makes the same offer acceptable.
    const published = await recipient.signed("put", "/v1/instances/me/transfer-key", { transferPublicKey: recipient.transferKey.publicKeyBase64 });
    expect(published.status).toBe(200);
    expect(published.body.instance.transferPublicKey).toBe(recipient.transferKey.publicKeyBase64);
    const retry = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(chunks)));
    expect(retry.status).toBe(201);
  });

  it("every chunk must exist and belong to the donor's account; a duplicate is malformed", async () => {
    const { donor, recipient } = await twoDevices();
    const stranger = await TestInstance.register(h.app, accountId("stranger"));
    const [mine] = await uploadChunks(donor, 1);
    const [theirs] = await uploadChunks(stranger, 1);
    const unknown = randomBytes(32).toString("hex");

    const foreign = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor([mine, theirs])));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.details).toEqual({ chunkBlobIds: [theirs] });

    const missing = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor([unknown, mine])));
    expect(missing.status).toBe(404);
    expect(missing.body.error.details).toEqual({ chunkBlobIds: [unknown] });

    const duplicate = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor([mine, mine])));
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.error.code).toBe("validation_failed");

    // None of the refusals touched the stranger's blob or the donor's.
    for (const date of (await expiresAtOf([mine, theirs])).values()) expect(date).not.toBeNull();
  });

  it("verifies the manifest signature against the DONOR's key: another key, a tampered manifest and a backup manifest are refused", async () => {
    const { donor, recipient } = await twoDevices();
    const chunks = await uploadChunks(donor, 1);
    const manifest = manifestFor(chunks);

    const otherKey = generateEd25519();
    const forged = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, {
      ...offerBody(donor, recipient, manifest),
      manifestSignature: signMessage(otherKey, archiveManifestMessage(manifest)),
    });
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe("unauthorized");

    // Signed by the donor, then one field changed after signing.
    const signedBody = offerBody(donor, recipient, manifest);
    const tampered = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, {
      ...signedBody,
      manifest: { ...manifest, eventCount: manifest.eventCount + 1 },
    });
    expect(tampered.status).toBe(401);

    // The recipient's own key does not sign a donor's manifest.
    const wrongSigner = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, {
      ...signedBody,
      manifestSignature: signMessage(recipient.key, archiveManifestMessage(manifest)),
    });
    expect(wrongSigner.status).toBe(401);

    // A backup manifest, even correctly signed, is not an offer.
    const backupManifest = manifestFor(chunks, "backup");
    const backupKind = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, backupManifest));
    expect(backupKind.status).toBe(400);
    expect(backupKind.body.error.code).toBe("validation_failed");

    for (const date of (await expiresAtOf(chunks)).values()) expect(date).not.toBeNull();
    expect(h.realtime.historyOffers).toEqual([]);
  });

  it("requires the instance signature; an Oxy session alone is 401", async () => {
    const { donor, recipient } = await twoDevices();
    const response = await request(h.app)
      .post(`/v1/instances/${recipient.id}/history-offers`)
      .set(USER_HEADER, donor.accountId)
      .send(offerBody(donor, recipient, manifestFor([randomBytes(32).toString("hex")])));
    expect(response.status).toBe(401);
  });

  it("one pending offer per (donor, recipient): a newer one replaces the older, whose unshared chunks are released", async () => {
    const { donor, recipient } = await twoDevices();
    const [shared, onlyOld] = await uploadChunks(donor, 2);
    const [onlyNew] = await uploadChunks(donor, 1);

    const first = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor([shared, onlyOld])));
    expect(first.status).toBe(201);
    const second = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor([shared, onlyNew])));
    expect(second.status).toBe(201);

    expect(await offerStatus(first.body.offer.id)).toBe("expired");
    expect(await offerStatus(second.body.offer.id)).toBe("pending");
    const dates = await expiresAtOf([shared, onlyOld, onlyNew]);
    expect(dates.get(shared)).toBeNull();
    expect(dates.get(onlyNew)).toBeNull();
    expectDatedAbout(dates.get(onlyOld), CHUNK_RELEASE_TTL_MS);

    const listed = await recipient.signed("get", "/v1/instances/me/history-offers");
    const { offers } = expectParses(listHistoryOffersResponseSchema, listed.body);
    expect(offers.map((offer) => offer.id)).toEqual([second.body.offer.id]);

    // Two nudges, one per offer created.
    expect(h.realtime.historyOffers.map((n) => n.offerId)).toEqual([first.body.offer.id, second.body.offer.id]);
  });

  it("a second donor's offer to the same recipient does not replace the first donor's", async () => {
    const { account, donor, recipient } = await twoDevices();
    const third = await TestInstance.register(h.app, account, { platform: "desktop" });
    await donor.approve(third);
    const a = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(await uploadChunks(donor, 1))));
    const b = await third.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(third, recipient, manifestFor(await uploadChunks(third, 1))));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const listed = await recipient.signed("get", "/v1/instances/me/history-offers");
    expect(listed.body.offers.map((o: { id: string }) => o.id).sort()).toEqual([a.body.offer.id, b.body.offer.id].sort());
  });
});

describe("GET /v1/instances/me/history-offers", () => {
  it("lists the caller's pending offers only: the donor sees nothing, a stranger sees nothing", async () => {
    const { donor, recipient } = await twoDevices();
    const stranger = await TestInstance.register(h.app, accountId("stranger"));
    const created = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(await uploadChunks(donor, 1))));
    expect(created.status).toBe(201);

    const mine = expectParses(listHistoryOffersResponseSchema, (await recipient.signed("get", "/v1/instances/me/history-offers")).body);
    expect(mine.offers.map((offer) => offer.id)).toEqual([created.body.offer.id]);
    expect(mine.offers[0].sealedKey).toBe(created.body.offer.sealedKey);

    expect((await donor.signed("get", "/v1/instances/me/history-offers")).body.offers).toEqual([]);
    expect((await stranger.signed("get", "/v1/instances/me/history-offers")).body.offers).toEqual([]);
  });

  it("marks a past-due offer expired on read and releases its chunks", async () => {
    const { donor, recipient } = await twoDevices();
    const chunks = await uploadChunks(donor, 2);
    const created = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(chunks)));
    await h.db
      .update(schema.historyOffers)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.historyOffers.id, created.body.offer.id));

    const listed = await recipient.signed("get", "/v1/instances/me/history-offers");
    expect(listed.body.offers).toEqual([]);
    expect(await offerStatus(created.body.offer.id)).toBe("expired");
    for (const date of (await expiresAtOf(chunks)).values()) expectDatedAbout(date, CHUNK_RELEASE_TTL_MS);
  });
});

describe("POST /v1/instances/me/history-offers/:id/consume", () => {
  it("the recipient consumes once; the chunks are dated a day out; a second consume is a conflict", async () => {
    const { donor, recipient } = await twoDevices();
    const chunks = await uploadChunks(donor, 2);
    const created = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(chunks)));
    const id = created.body.offer.id as string;

    const consumed = await recipient.signed("post", `/v1/instances/me/history-offers/${id}/consume`);
    expect(consumed.status).toBe(200);
    const { offer } = expectParses(historyOfferResponseSchema, consumed.body);
    expect(offer.status).toBe("consumed");
    expect(offer.id).toBe(id);
    for (const date of (await expiresAtOf(chunks)).values()) expectDatedAbout(date, CHUNK_RELEASE_TTL_MS);
    const [row] = await h.db.select().from(schema.historyOffers).where(eq(schema.historyOffers.id, id));
    expect(row.consumedAt).not.toBeNull();

    const again = await recipient.signed("post", `/v1/instances/me/history-offers/${id}/consume`);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("idempotency_conflict");
    expect((await recipient.signed("get", "/v1/instances/me/history-offers")).body.offers).toEqual([]);
  });

  it("only the recipient may consume: the donor and a stranger get not_found", async () => {
    const { donor, recipient } = await twoDevices();
    const stranger = await TestInstance.register(h.app, accountId("stranger"));
    const created = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(await uploadChunks(donor, 1))));
    const id = created.body.offer.id as string;
    expect((await donor.signed("post", `/v1/instances/me/history-offers/${id}/consume`)).status).toBe(404);
    expect((await stranger.signed("post", `/v1/instances/me/history-offers/${id}/consume`)).status).toBe(404);
    expect((await recipient.signed("post", `/v1/instances/me/history-offers/${randomBytes(16).toString("hex")}/consume`)).status).toBe(404);
    expect(await offerStatus(id)).toBe("pending");
  });

  it("a past-due offer cannot be consumed: it is marked expired instead", async () => {
    const { donor, recipient } = await twoDevices();
    const chunks = await uploadChunks(donor, 1);
    const created = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(chunks)));
    const id = created.body.offer.id as string;
    await h.db.update(schema.historyOffers).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.historyOffers.id, id));
    const response = await recipient.signed("post", `/v1/instances/me/history-offers/${id}/consume`);
    expect(response.status).toBe(409);
    expect(await offerStatus(id)).toBe("expired");
    for (const date of (await expiresAtOf(chunks)).values()) expectDatedAbout(date, CHUNK_RELEASE_TTL_MS);
  });

  it("consuming keeps a chunk that another pending offer, the backup or an event still names", async () => {
    const { account, donor, recipient } = await twoDevices();
    const third = await TestInstance.register(h.app, account, { platform: "desktop" });
    await donor.approve(third);
    const [byOffer, byBackup, byEvent, alone] = await uploadChunks(donor, 4);

    // The same chunk in a second offer (to a different recipient).
    await donor.signed("post", `/v1/instances/${third.id}/history-offers`, offerBody(donor, third, manifestFor([byOffer]))).expect(201);
    // The same chunk in the account's backup.
    const backupManifest = manifestFor([byBackup], "backup");
    await donor
      .signed("put", "/v1/accounts/me/backup", {
        manifest: backupManifest,
        keyCheck: randomBytes(32).toString("base64"),
        manifestSignature: signMessage(donor.key, archiveManifestMessage(backupManifest)),
      })
      .expect(200);
    // The same chunk named by a conversation event of the donor's.
    const dm = await dmBetween(h.app);
    const media = await dm.a.uploadBlob(Buffer.from("media"));
    const eventBlob = media.body.blobId as string;
    await dm.a
      .signed("post", `/v1/conversations/${dm.conversationId}/events`, {
        idempotencyKey: `k-${Date.now()}-${Math.random()}`,
        kind: "app_message",
        epoch: 1,
        payload: base64("m"),
        blobIds: [eventBlob],
      })
      .expect(200);
    // `byEvent` stands in for an event-retained chunk of the donor's own; the
    // event above is on another account, so retain the donor's chunk through
    // an event row directly — what matters is the reference, not who wrote it.
    await h.db.update(schema.conversationEvents).set({ blobIds: [eventBlob, byEvent] }).where(eq(schema.conversationEvents.conversationId, dm.conversationId));

    const created = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor([byOffer, byBackup, byEvent, alone])));
    expect(created.status).toBe(201);
    await recipient.signed("post", `/v1/instances/me/history-offers/${created.body.offer.id}/consume`).expect(200);

    const dates = await expiresAtOf([byOffer, byBackup, byEvent, alone]);
    expect(dates.get(byOffer)).toBeNull();
    expect(dates.get(byBackup)).toBeNull();
    expect(dates.get(byEvent)).toBeNull();
    expectDatedAbout(dates.get(alone), CHUNK_RELEASE_TTL_MS);
  });
});

describe("expiry and collection", () => {
  it("the expiry sweep releases a due offer's chunks BEFORE it deletes the row", async () => {
    const { donor, recipient } = await twoDevices();
    const chunks = await uploadChunks(donor, 2);
    const created = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(chunks)));
    const id = created.body.offer.id as string;
    await h.db.update(schema.historyOffers).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.historyOffers.id, id));

    await runExpirySweep(h.db, silentLog);

    expect(await h.db.select().from(schema.historyOffers).where(eq(schema.historyOffers.id, id))).toHaveLength(0);
    const dates = await expiresAtOf(chunks);
    expect(dates.size).toBe(2);
    for (const date of dates.values()) expectDatedAbout(date, CHUNK_RELEASE_TTL_MS);
  });

  it("a released chunk is reaped by the ordinary blob sweep once its day has passed", async () => {
    const { donor, recipient } = await twoDevices();
    const chunks = await uploadChunks(donor, 1);
    const created = await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor(chunks)));
    await recipient.signed("post", `/v1/instances/me/history-offers/${created.body.offer.id}/consume`).expect(200);
    await h.db.update(schema.blobs).set({ expiresAt: new Date(Date.now() - 1_000) }).where(inArray(schema.blobs.id, chunks));
    await runExpirySweep(h.db, silentLog);
    expect((await expiresAtOf(chunks)).size).toBe(0);
  });

  it("the collector's orphan pass dates an old undated blob nothing names, and leaves what an offer, the backup or an event names", async () => {
    const { donor, recipient } = await twoDevices();
    const [orphan, byOffer, byBackup, young] = await uploadChunks(donor, 4);
    const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS);

    await donor.signed("post", `/v1/instances/${recipient.id}/history-offers`, offerBody(donor, recipient, manifestFor([byOffer]))).expect(201);
    const backupManifest = manifestFor([byBackup], "backup");
    await donor
      .signed("put", "/v1/accounts/me/backup", {
        manifest: backupManifest,
        keyCheck: randomBytes(32).toString("base64"),
        manifestSignature: signMessage(donor.key, archiveManifestMessage(backupManifest)),
      })
      .expect(200);
    const dm = await dmBetween(h.app);
    const media = await dm.a.uploadBlob(Buffer.from("media"));
    const byEvent = media.body.blobId as string;
    await dm.a
      .signed("post", `/v1/conversations/${dm.conversationId}/events`, {
        idempotencyKey: `k-${Date.now()}-${Math.random()}`,
        kind: "app_message",
        epoch: 1,
        payload: base64("m"),
        blobIds: [byEvent],
      })
      .expect(200);

    // `orphan` looks exactly like a chunk whose offer row vanished: undated, old, unnamed.
    await h.db.update(schema.blobs).set({ expiresAt: null, createdAt: eightDaysAgo }).where(eq(schema.blobs.id, orphan));
    await h.db.update(schema.blobs).set({ expiresAt: null }).where(eq(schema.blobs.id, young));
    await h.db.update(schema.blobs).set({ createdAt: eightDaysAgo }).where(inArray(schema.blobs.id, [byOffer, byBackup, byEvent]));

    await runBlobGc({ db: h.db });

    const dates = await expiresAtOf([orphan, byOffer, byBackup, byEvent, young]);
    expectDatedAbout(dates.get(orphan), CHUNK_RELEASE_TTL_MS);
    expect(dates.get(byOffer)).toBeNull();
    expect(dates.get(byBackup)).toBeNull();
    expect(dates.get(byEvent)).toBeNull();
    // Too young to be an orphan: it could be a chunk about to be offered.
    expect(dates.get(young)).toBeNull();
  });
});
