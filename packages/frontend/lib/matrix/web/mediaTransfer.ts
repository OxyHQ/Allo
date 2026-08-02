import { Attachment, EncryptedAttachment } from '@matrix-org/matrix-sdk-crypto-wasm';

import { MatrixMediaUnreadableError } from '@/lib/matrix/errors';
import type { AlloMediaFile } from '@/lib/matrix/types';

/**
 * The browser-facing half of attachments: bytes in, bytes out, and the crypto
 * machine in between.
 *
 * Kept apart from `attachments.ts` on purpose. That file decides *what* to send
 * and is a pure function of its arguments, so its tests can assert on the exact
 * bytes that would reach a homeserver without a browser or 7.8 MB of
 * WebAssembly. This one touches `fetch`, `Blob`, `URL` and the wasm module, and
 * cannot be tested without them.
 *
 * The encryption itself is the Rust crypto machine's, through
 * `@matrix-org/matrix-sdk-crypto-wasm` — the same code that encrypts
 * attachments on iOS and Android, compiled differently. Allo does not implement
 * AES-CTR, does not choose an IV and does not compute the SHA-256, which is the
 * only acceptable amount of attachment cryptography for an app to write.
 */

/**
 * Reads an attachment's bytes off whatever URI the picker handed over.
 *
 * `fetch` covers all three shapes a browser produces — `blob:`, `data:` and an
 * ordinary URL — and is the reason the port takes a URI rather than a `File`:
 * the same field means a filesystem path on a phone, and neither caller has to
 * know which platform it is on.
 */
export async function readAttachmentBytes(uri: string): Promise<Uint8Array> {
  const response = await fetch(uri);
  if (!response.ok) {
    throw new MatrixMediaUnreadableError(
      `the browser could not read the chosen file (HTTP ${response.status})`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Encrypts an attachment, and answers with the ciphertext and the key material.
 *
 * The `EncryptedAttachment` is freed before returning. It holds its buffers in
 * WebAssembly memory, which no JavaScript garbage collector can see, so a tab
 * that sends a few videos without this leaks their whole size.
 */
export function encryptAttachment(plaintext: Uint8Array): {
  readonly ciphertext: Uint8Array;
  readonly info: string;
} {
  const encrypted = Attachment.encrypt(plaintext);
  try {
    const ciphertext = encrypted.encryptedData;
    const info = encrypted.mediaEncryptionInfo;
    if (info === undefined) {
      throw new MatrixMediaUnreadableError(
        'the encryption machine produced no key for the attachment it encrypted',
      );
    }
    return { ciphertext, info };
  } finally {
    encrypted.free();
  }
}

/**
 * Decrypts an attachment downloaded from the media repository.
 *
 * The key material is consumed by the decryption — the machine's own warning is
 * that an `EncryptedAttachment` "can be used only once" — which is why a fresh
 * one is built here from the event's `file` block on every call rather than
 * kept around.
 */
export function decryptAttachment(ciphertext: Uint8Array, info: string): Uint8Array {
  const encrypted = new EncryptedAttachment(ciphertext, info);
  try {
    return Attachment.decrypt(encrypted);
  } catch (error) {
    throw new MatrixMediaUnreadableError(
      `the key in the event did not open it (${describe(error)})`,
    );
  } finally {
    encrypted.free();
  }
}

/**
 * Wraps decrypted bytes in something an `<img>` or a `<video>` can point at.
 *
 * `release()` is not optional housekeeping: an object URL pins its bytes in the
 * tab for as long as the document lives, whether or not anything still refers
 * to it, and these bytes are a photograph from an encrypted conversation.
 */
export function toObjectUrl(bytes: Uint8Array, mimetype: string): AlloMediaFile {
  // `slice()` because a Blob must own a plain ArrayBuffer, and the array here
  // may be a view onto a larger one.
  const uri = URL.createObjectURL(new Blob([bytes.slice().buffer], { type: mimetype }));
  let released = false;
  return {
    uri,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      URL.revokeObjectURL(uri);
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
