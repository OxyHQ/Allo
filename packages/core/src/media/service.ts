/**
 * Media: a file is encrypted on the device with a random AES-256-GCM key,
 * uploaded as an opaque blob, and the key travels only inside the `media`
 * app message. Download reverses it and verifies the ciphertext digest
 * before decrypting. Keys are persisted (encrypted at rest) in `mediaKey`
 * records so a `MediaRef` is enough to fetch.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { BLOB_SHA256_HEADER, uploadBlobResponseSchema, type AppMessage } from "@allo/shared-types";
import type { Context } from "../context";
import { DecryptError, NotFoundError } from "../errors";
import type { MediaRef, UploadMediaMeta } from "../types";
import { base64Decode, base64Encode, randomBytes, sha256Hex } from "../util/bytes";

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
    const res = await ctx.http.request({
      method: "POST",
      path: "/v1/blobs",
      rawBody: ciphertext,
      headers: { [BLOB_SHA256_HEADER]: digest },
      schema: uploadBlobResponseSchema,
      signer: ctx.signer,
    });
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
    };
    const record = { blobId: res.blobId, conversationId, key: message.key, nonce: message.nonce, sha256: digest, mime: meta.mime, size: bytes.byteLength };
    await ctx.store.putJson("mediaKey", res.blobId, record);
    ctx.model.mediaKeys.set(res.blobId, record);
    const item = await ctx.outbox.enqueueMessage(conversationId, message, [res.blobId]);
    return item.id;
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
