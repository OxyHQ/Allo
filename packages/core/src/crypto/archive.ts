/**
 * Archive encryption: the `encodeArchive` bytes are split into pieces of at
 * most {@link ARCHIVE_CHUNK_MAX_BYTES}, each AES-256-GCM under the archive
 * key with a fresh 12-byte nonce prefixed and `archiveChunkAad(i, n)` as
 * additional data, so a chunk cannot be dropped, duplicated or reordered
 * without the decryption failing. Every chunk is one blob on the server.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { ARCHIVE_CHUNK_MAX_BYTES, ARCHIVE_MAX_CHUNKS, archiveChunkAad } from "@allo/shared-types";
import { DecryptError, InvalidStateError } from "../errors";
import { concatBytes, randomBytes, utf8Encode } from "../util/bytes";

export const ARCHIVE_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export function generateArchiveKey(): Uint8Array {
  return randomBytes(ARCHIVE_KEY_BYTES);
}

/** Splits and encrypts. An empty plaintext still yields one (empty-bodied) chunk: a manifest lists at least one. */
export function encryptArchive(key: Uint8Array, plaintext: Uint8Array, chunkBytes = ARCHIVE_CHUNK_MAX_BYTES): Uint8Array[] {
  if (key.length !== ARCHIVE_KEY_BYTES) throw new InvalidStateError("archive key must be 32 bytes");
  if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > ARCHIVE_CHUNK_MAX_BYTES) throw new InvalidStateError("chunk size out of range");
  const total = Math.max(1, Math.ceil(plaintext.length / chunkBytes));
  if (total > ARCHIVE_MAX_CHUNKS) throw new InvalidStateError(`archive needs ${total} chunks; at most ${ARCHIVE_MAX_CHUNKS} allowed`);
  const out: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    const piece = plaintext.subarray(i * chunkBytes, Math.min(plaintext.length, (i + 1) * chunkBytes));
    const nonce = randomBytes(NONCE_BYTES);
    out.push(concatBytes(nonce, gcm(key, nonce, utf8Encode(archiveChunkAad(i, total))).encrypt(piece)));
  }
  return out;
}

/** The inverse of {@link encryptArchive}; the chunks must be all of them, in order. Throws {@link DecryptError}. */
export function decryptArchive(key: Uint8Array, chunks: Uint8Array[]): Uint8Array {
  if (key.length !== ARCHIVE_KEY_BYTES) throw new InvalidStateError("archive key must be 32 bytes");
  if (chunks.length === 0) throw new DecryptError("an archive has at least one chunk");
  const pieces: Uint8Array[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk.length < NONCE_BYTES + TAG_BYTES) throw new DecryptError(`archive chunk ${i} is too short`);
    try {
      pieces.push(gcm(key, chunk.subarray(0, NONCE_BYTES), utf8Encode(archiveChunkAad(i, chunks.length))).decrypt(chunk.subarray(NONCE_BYTES)));
    } catch (cause) {
      throw new DecryptError(`archive chunk ${i} failed authentication`, { cause });
    }
  }
  return concatBytes(...pieces);
}
