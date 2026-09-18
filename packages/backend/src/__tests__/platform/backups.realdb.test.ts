/**
 * The account backup: `PUT`, `GET`, `DELETE /v1/accounts/me/backup` against a
 * real database with real keys — the rules of `services/platform/backupService.ts`,
 * the response shapes, and the chunk-blob retention on put, replace and delete.
 */

import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { archiveManifestMessage, backupResponseSchema, errorResponseSchema, type ArchiveManifest } from "@allo/shared-types";
import * as schema from "../../db/schema";
import { CHUNK_RELEASE_TTL_MS } from "../../db/platform/historyRepository";
import {
  accountId,
  createPlatformHarness,
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

async function uploadChunks(who: TestInstance, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const response = await who.uploadBlob(randomBytes(48));
    if (response.status !== 201) throw new Error(`chunk upload failed: ${response.status}`);
    ids.push(response.body.blobId as string);
  }
  return ids;
}

function manifestFor(chunkBlobIds: string[], kind: ArchiveManifest["kind"] = "backup"): ArchiveManifest {
  return {
    v: 1,
    kind,
    createdAt: new Date().toISOString(),
    conversationCount: 3,
    eventCount: 120,
    chunkBlobIds,
    plaintextSha256: randomBytes(32).toString("hex"),
  };
}

function backupBody(writer: TestInstance, manifest: ArchiveManifest) {
  return {
    manifest,
    keyCheck: randomBytes(32).toString("base64"),
    manifestSignature: signMessage(writer.key, archiveManifestMessage(manifest)),
  };
}

async function expiresAtOf(blobIds: readonly string[]): Promise<Map<string, Date | null>> {
  const rows = await h.db
    .select({ id: schema.blobs.id, expiresAt: schema.blobs.expiresAt })
    .from(schema.blobs)
    .where(inArray(schema.blobs.id, [...blobIds]));
  return new Map(rows.map((row) => [row.id, row.expiresAt]));
}

function expectDatedAbout(date: Date | null | undefined, ms: number): void {
  expect(date).toBeInstanceOf(Date);
  expect(Math.abs((date as Date).getTime() - (Date.now() + ms))).toBeLessThan(60_000);
}

describe("GET and DELETE /v1/accounts/me/backup with none", () => {
  it("GET answers { backup: null } and DELETE 404 backup_not_found", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const got = await me.signed("get", "/v1/accounts/me/backup");
    expect(got.status).toBe(200);
    expect(expectParses(backupResponseSchema, got.body)).toEqual({ backup: null });

    const gone = await me.signed("delete", "/v1/accounts/me/backup");
    expect(gone.status).toBe(404);
    expect(expectParses(errorResponseSchema, gone.body).error.code).toBe("backup_not_found");
  });

  it("requires the instance signature; an Oxy session alone is 401", async () => {
    const me = await TestInstance.register(h.app, accountId());
    expect((await request(h.app).get("/v1/accounts/me/backup").set(USER_HEADER, me.accountId)).status).toBe(401);
  });
});

describe("PUT /v1/accounts/me/backup", () => {
  it("stores the backup for the writing instance, echoes the key check and retains the chunks", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const chunks = await uploadChunks(me, 2);
    for (const date of (await expiresAtOf(chunks)).values()) expect(date).not.toBeNull();

    const body = backupBody(me, manifestFor(chunks));
    const put = await me.signed("put", "/v1/accounts/me/backup", body);
    expect(put.status).toBe(200);
    const { backup } = expectParses(backupResponseSchema, put.body);
    expect(backup).not.toBeNull();
    expect(backup?.accountId).toBe(me.accountId);
    expect(backup?.instanceId).toBe(me.id);
    expect(backup?.manifest).toEqual(body.manifest);
    expect(backup?.keyCheck).toBe(body.keyCheck);
    expect(backup?.manifestSignature).toBe(body.manifestSignature);
    for (const date of (await expiresAtOf(chunks)).values()) expect(date).toBeNull();

    const got = await me.signed("get", "/v1/accounts/me/backup");
    expect(expectParses(backupResponseSchema, got.body).backup).toEqual(backup);
  });

  it("is the account's own: another account sees null, and its GET is not the writer's", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const stranger = await TestInstance.register(h.app, accountId("stranger"));
    await me.signed("put", "/v1/accounts/me/backup", backupBody(me, manifestFor(await uploadChunks(me, 1)))).expect(200);
    expect((await stranger.signed("get", "/v1/accounts/me/backup")).body).toEqual({ backup: null });
    expect((await stranger.signed("delete", "/v1/accounts/me/backup")).status).toBe(404);
    expect((await me.signed("get", "/v1/accounts/me/backup")).body.backup).not.toBeNull();
  });

  it("refuses a transfer manifest, a signature by another key, a tampered manifest and a foreign or missing chunk", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const stranger = await TestInstance.register(h.app, accountId("stranger"));
    const [mine] = await uploadChunks(me, 1);
    const [theirs] = await uploadChunks(stranger, 1);

    const transferKind = await me.signed("put", "/v1/accounts/me/backup", backupBody(me, manifestFor([mine], "transfer")));
    expect(transferKind.status).toBe(400);
    expect(transferKind.body.error.code).toBe("validation_failed");

    const manifest = manifestFor([mine]);
    const forged = await me.signed("put", "/v1/accounts/me/backup", {
      ...backupBody(me, manifest),
      manifestSignature: signMessage(generateEd25519(), archiveManifestMessage(manifest)),
    });
    expect(forged.status).toBe(401);

    const tampered = await me.signed("put", "/v1/accounts/me/backup", {
      ...backupBody(me, manifest),
      manifest: { ...manifest, conversationCount: 99 },
    });
    expect(tampered.status).toBe(401);

    const foreign = await me.signed("put", "/v1/accounts/me/backup", backupBody(me, manifestFor([mine, theirs])));
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.details).toEqual({ chunkBlobIds: [theirs] });

    const missing = await me.signed("put", "/v1/accounts/me/backup", backupBody(me, manifestFor([randomBytes(32).toString("hex")])));
    expect(missing.status).toBe(404);

    expect((await me.signed("get", "/v1/accounts/me/backup")).body).toEqual({ backup: null });
    for (const date of (await expiresAtOf([mine, theirs])).values()) expect(date).not.toBeNull();
  });

  it("replaces the previous backup: dropped chunks are dated a day out, shared ones stay, and another instance may write it", async () => {
    const account = accountId();
    const phone = await TestInstance.register(h.app, account);
    const laptop = await TestInstance.register(h.app, account, { platform: "desktop" });
    await phone.approve(laptop);
    const [shared, onlyOld] = await uploadChunks(phone, 2);
    const [onlyNew] = await uploadChunks(laptop, 1);

    await phone.signed("put", "/v1/accounts/me/backup", backupBody(phone, manifestFor([shared, onlyOld]))).expect(200);
    const second = await laptop.signed("put", "/v1/accounts/me/backup", backupBody(laptop, manifestFor([shared, onlyNew])));
    expect(second.status).toBe(200);
    expect(second.body.backup.instanceId).toBe(laptop.id);

    const rows = await h.db.select().from(schema.accountBackups).where(eq(schema.accountBackups.accountId, account));
    expect(rows).toHaveLength(1);
    expect(rows[0].chunkBlobIds).toEqual([shared, onlyNew]);

    const dates = await expiresAtOf([shared, onlyOld, onlyNew]);
    expect(dates.get(shared)).toBeNull();
    expect(dates.get(onlyNew)).toBeNull();
    expectDatedAbout(dates.get(onlyOld), CHUNK_RELEASE_TTL_MS);

    const got = expectParses(backupResponseSchema, (await phone.signed("get", "/v1/accounts/me/backup")).body);
    expect(got.backup?.manifest.chunkBlobIds).toEqual([shared, onlyNew]);
  });

  it("a chunk a pending history offer also names survives the backup's replacement", async () => {
    const account = accountId();
    const phone = await TestInstance.register(h.app, account);
    const laptop = await TestInstance.register(h.app, account, { platform: "desktop" });
    await phone.approve(laptop);
    const [chunk] = await uploadChunks(phone, 1);
    const [other] = await uploadChunks(phone, 1);
    const offerManifest = manifestFor([chunk], "transfer");
    await phone
      .signed("post", `/v1/instances/${laptop.id}/history-offers`, {
        recipientInstanceId: laptop.id,
        manifest: offerManifest,
        sealedKey: randomBytes(80).toString("base64"),
        manifestSignature: signMessage(phone.key, archiveManifestMessage(offerManifest)),
      })
      .expect(201);
    await phone.signed("put", "/v1/accounts/me/backup", backupBody(phone, manifestFor([chunk]))).expect(200);
    await phone.signed("put", "/v1/accounts/me/backup", backupBody(phone, manifestFor([other]))).expect(200);
    expect((await expiresAtOf([chunk])).get(chunk)).toBeNull();
  });
});

describe("DELETE /v1/accounts/me/backup", () => {
  it("removes the backup and releases its chunks; GET is null again", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const chunks = await uploadChunks(me, 2);
    await me.signed("put", "/v1/accounts/me/backup", backupBody(me, manifestFor(chunks))).expect(200);

    const deleted = await me.signed("delete", "/v1/accounts/me/backup");
    expect(deleted.status).toBe(204);
    expect((await me.signed("get", "/v1/accounts/me/backup")).body).toEqual({ backup: null });
    for (const date of (await expiresAtOf(chunks)).values()) expectDatedAbout(date, CHUNK_RELEASE_TTL_MS);
    expect((await me.signed("delete", "/v1/accounts/me/backup")).status).toBe(404);
  });
});
