/**
 * The bytes of something a picker chose, on iOS and Android.
 *
 * A picker answers a `file://` URI (the document picker copies into the cache
 * directory first; see `lib/chat/attachments.ts`), and the SDK encrypts BYTES,
 * so the file is read whole. Attachments are bounded by what a phone can hold
 * in memory to encrypt anyway; streaming would need a streaming cipher the
 * SDK does not offer.
 */
import { File } from 'expo-file-system';

export async function readAttachmentBytes(uri: string): Promise<Uint8Array> {
  return new File(uri).bytes();
}
