/**
 * Blobs: upload with digest and size checks, download, the collector.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { BLOB_SHA256_HEADER, uploadBlobResponseSchema } from "@allo/shared-types";
import * as schema from "../../db/schema";
import { runBlobGc } from "../../workers/blobGc";
import { accountId, createPlatformHarness, expectParses, TEST_BLOB_MAX_BYTES, TestInstance, type PlatformHarness } from "./harness";

let h: PlatformHarness;

beforeAll(async () => {
  h = await createPlatformHarness();
}, 180_000);

afterAll(async () => {
  await h?.drop();
});

describe("POST /v1/blobs and GET /v1/blobs/:id", () => {
  it("stores the bytes under an unguessable id and any authenticated instance can read them back", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const bytes = Buffer.from("ciphertext-of-a-photo");
    const upload = await me.uploadBlob(bytes);
    expect(upload.status).toBe(201);
    const parsed = expectParses(uploadBlobResponseSchema, upload.body);
    expect(parsed.size).toBe(bytes.length);
    expect(parsed.blobId).toMatch(/^[0-9a-f]{64}$/);

    const [row] = await h.db.select().from(schema.blobs).where(eq(schema.blobs.id, parsed.blobId));
    expect(row.uploaderInstanceId).toBe(me.id);
    expect(row.expiresAt).not.toBeNull();
    expect(row.storageKey).toBe("postgres");

    const someoneElse = await TestInstance.register(h.app, accountId());
    const download = await someoneElse.signed("get", `/v1/blobs/${parsed.blobId}`).buffer(true).parse(binaryParser);
    expect(download.status).toBe(200);
    expect(download.headers["content-type"]).toBe("application/octet-stream");
    expect(Buffer.compare(download.body as Buffer, bytes)).toBe(0);

    const missing = await me.signed("get", `/v1/blobs/${"0".repeat(64)}`);
    expect(missing.status).toBe(404);
  });

  it("refuses a digest mismatch and a missing digest with 400", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const bytes = Buffer.from("payload");
    const wrong = await me.uploadBlob(bytes, "0".repeat(64));
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("validation_failed");

    const noHeader = await request(h.app)
      .post("/v1/blobs")
      .set(me.headers("POST", "/v1/blobs", bytes))
      .set("content-type", "application/octet-stream")
      .send(bytes);
    expect(noHeader.status).toBe(400);
    expect(await h.db.select().from(schema.blobs).where(eq(schema.blobs.uploaderInstanceId, me.id))).toHaveLength(0);
  });

  it("refuses an oversized blob with 413 payload_too_large before reading it", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const bytes = Buffer.alloc(TEST_BLOB_MAX_BYTES + 1, 7);
    const response = await me.uploadBlob(bytes);
    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe("payload_too_large");
    const exact = await me.uploadBlob(Buffer.alloc(TEST_BLOB_MAX_BYTES, 7));
    expect(exact.status).toBe(201);
  });

  it("requires the signature over the BYTES: a body swapped after signing is refused", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const bytes = Buffer.from("signed-bytes");
    const other = Buffer.from("other-bytes");
    const response = await request(h.app)
      .post("/v1/blobs")
      .set(me.headers("POST", "/v1/blobs", bytes))
      .set(BLOB_SHA256_HEADER, "0".repeat(64))
      .set("content-type", "application/octet-stream")
      .send(other);
    expect(response.status).toBe(401);
  });
});

describe("the blob collector", () => {
  it("deletes expired unreferenced blobs and a revoked uploader's unreferenced ones, keeps the rest", async () => {
    const me = await TestInstance.register(h.app, accountId());
    const account = accountId();
    const revoked = await TestInstance.register(h.app, account);
    const fresh = (await me.uploadBlob(Buffer.from("fresh"))).body.blobId as string;
    const old = (await me.uploadBlob(Buffer.from("old"))).body.blobId as string;
    const kept = (await me.uploadBlob(Buffer.from("kept"))).body.blobId as string;
    const orphan = (await revoked.uploadBlob(Buffer.from("orphan"))).body.blobId as string;
    await h.db.update(schema.blobs).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(schema.blobs.id, old));
    await h.db.update(schema.blobs).set({ expiresAt: null }).where(eq(schema.blobs.id, kept));
    await revoked.signed("post", `/v1/instances/${revoked.id}/revoke`).expect(200);

    const deleted = await runBlobGc({ db: h.db });
    expect(deleted).toBeGreaterThanOrEqual(2);
    const remaining = (await h.db.select({ id: schema.blobs.id }).from(schema.blobs)).map((r) => r.id);
    expect(remaining).toContain(fresh);
    expect(remaining).toContain(kept);
    expect(remaining).not.toContain(old);
    expect(remaining).not.toContain(orphan);
    // The bytes went with the row.
    expect(await h.db.select().from(schema.blobBytes).where(eq(schema.blobBytes.blobId, old))).toHaveLength(0);
  });
});

function binaryParser(res: request.Response, callback: (error: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  const stream = res as unknown as NodeJS.ReadableStream;
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  stream.on("end", () => callback(null, Buffer.concat(chunks)));
}
