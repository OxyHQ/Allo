/**
 * Media: a file is encrypted on the device with a random AES-256-GCM key,
 * uploaded as an opaque blob, and the key travels only inside the `media`
 * app message. Download reverses it and verifies the ciphertext digest
 * before decrypting. Keys are persisted (encrypted at rest) in `mediaKey`
 * records so a `MediaRef` is enough to fetch. A thumbnail is a second blob
 * under its own key, named by the same `media` message.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { BLOB_SHA256_HEADER, uploadBlobResponseSchema, type AppMessage } from "@allo/shared-types";
import type { Context } from "../context";
import { DecryptError, NotFoundError } from "../errors";
import type { MediaRef, UploadMediaMeta } from "../types";
import { base64Decode, base64Encode, randomBytes, sha256Hex } from "../util/bytes";

/**
 * AES-256-GCM with a fresh nonce. The one encryption every attachment in this
 * SDK uses, factored out so a status update encrypts its picture exactly the
 * way a message encrypts one rather than nearly.
 */
export function encryptBytes(key: Uint8Array, bytes: Uint8Array): { ciphertext: Uint8Array; nonce: Uint8Array } {
  const nonce = randomBytes(12);
  return { ciphertext: gcm(key, nonce).encrypt(bytes), nonce };
}

/** The inverse. The caller verifies the digest BEFORE calling this. */
export function decryptBytes(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return gcm(key, nonce).decrypt(ciphertext);
}

/** Uploads ciphertext as a blob and answers its id. The server sees bytes and a digest. */
export async function uploadEncryptedBlob(ctx: Context, ciphertext: Uint8Array): Promise<string> {
  const res = await ctx.http.request({
    method: "POST",
    path: "/v1/blobs",
    rawBody: ciphertext,
    headers: { [BLOB_SHA256_HEADER]: sha256Hex(ciphertext) },
    schema: uploadBlobResponseSchema,
    signer: ctx.signer,
  });
  return res.blobId;
}

export class MediaService {
  constructor(private readonly ctx: Context) {}

  /** Encrypts, uploads and sends a `media` message. Returns the local key of the timeline item. */
  async upload(conversationId: string, bytes: Uint8Array, meta: UploadMediaMeta): Promise<string> {
    const { ctx } = this;
    ctx.instance.assertActive();
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const ciphertext = gcm(key, nonce).encrypt(bytes);
    const digest = sha256Hex(ciphertext);
    const res = await this.putBlob(ciphertext, digest);
    let thumbnail: Extract<AppMessage, { t: "media" }>["thumbnail"];
    let thumbnailRecord: { blobId: string; conversationId: string; key: string; nonce: string; sha256: string; mime: string; size: number } | undefined;
    if (meta.thumbnail) {
      const tKey = randomBytes(32);
      const tNonce = randomBytes(12);
      const tCiphertext = gcm(tKey, tNonce).encrypt(meta.thumbnail.bytes);
      const tDigest = sha256Hex(tCiphertext);
      const tRes = await this.putBlob(tCiphertext, tDigest);
      thumbnail = { blobId: tRes.blobId, key: base64Encode(tKey), nonce: base64Encode(tNonce), sha256: tDigest, width: meta.thumbnail.width, height: meta.thumbnail.height };
      thumbnailRecord = { blobId: tRes.blobId, conversationId, key: thumbnail.key, nonce: thumbnail.nonce, sha256: tDigest, mime: meta.thumbnail.mime, size: meta.thumbnail.bytes.byteLength };
    }
    const message: AppMessage = {
      v: 1,
      t: "media",
      blobId: res.blobId,
      key: base64Encode(key),
      nonce: base64Encode(nonce),
      sha256: digest,
      mime: meta.mime,
      filename: meta.filename,
      size: bytes.byteLength,
      kind: meta.kind,
      ...(meta.width !== undefined ? { width: meta.width } : {}),
      ...(meta.height !== undefined ? { height: meta.height } : {}),
      ...(meta.durationMs !== undefined ? { durationMs: meta.durationMs } : {}),
      ...(meta.caption !== undefined ? { caption: meta.caption } : {}),
      ...(thumbnail ? { thumbnail } : {}),
    };
    const record = { blobId: res.blobId, conversationId, key: message.key, nonce: message.nonce, sha256: digest, mime: meta.mime, size: bytes.byteLength };
    const batch = ctx.store.batch().putJson("mediaKey", res.blobId, record);
    if (thumbnailRecord) batch.putJson("mediaKey", thumbnailRecord.blobId, thumbnailRecord);
    await ctx.store.commit(batch);
    ctx.model.mediaKeys.set(res.blobId, record);
    if (thumbnailRecord) ctx.model.mediaKeys.set(thumbnailRecord.blobId, thumbnailRecord);
    const item = await ctx.outbox.enqueueMessage(conversationId, message, thumbnailRecord ? [res.blobId, thumbnailRecord.blobId] : [res.blobId]);
    return item.id;
  }

  private putBlob(ciphertext: Uint8Array, digest: string) {
    return this.ctx.http.request({
      method: "POST",
      path: "/v1/blobs",
      rawBody: ciphertext,
      headers: { [BLOB_SHA256_HEADER]: digest },
      schema: uploadBlobResponseSchema,
      signer: this.ctx.signer,
    });
  }

  /** Fetches, verifies and decrypts a blob named by a `MediaRef`. */
  async download(ref: MediaRef, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
    const { ctx } = this;
    const record = ctx.model.mediaKeys.get(ref.blobId);
    if (!record) throw new NotFoundError(`media key for blob ${ref.blobId}`);
    const ciphertext = await ctx.http.request<Uint8Array>({ method: "GET", path: `/v1/blobs/${ref.blobId}`, binary: true, signer: ctx.signer, signal: options.signal });
    if (sha256Hex(ciphertext) !== record.sha256) throw new DecryptError("blob digest does not match the message");
    try {
      return gcm(base64Decode(record.key), base64Decode(record.nonce)).decrypt(ciphertext);
    } catch (cause) {
      throw new DecryptError("blob failed authentication", { cause });
    }
  }
}
