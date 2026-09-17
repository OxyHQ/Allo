/**
 * Decrypted bytes → something `expo-image`, `expo-video` and `expo-audio` can
 * open, on iOS and Android: a file in the cache directory.
 *
 * The native players take a URI and nothing else, so a decrypted attachment
 * has to touch disk to be shown. It lands under `Paths.cache`, which the OS
 * may clear under pressure, and `release()` deletes it as soon as the
 * component that asked is gone. What is on disk at any moment is therefore
 * the plaintext of the attachments currently ON SCREEN, and nothing else —
 * not a history, not a cache that outlives a screen.
 */
import { Directory, File, Paths } from 'expo-file-system';
import { logger } from '@/utils/logger';
import { extensionForMime } from '@/utils/mimetypes';

export interface MediaUri {
  uri: string;
  release(): void;
}

const DIRECTORY = 'allo-media';

/** The one filename a blob gets, so the same blob mounted twice overwrites rather than accumulates. */
export function mediaFileName(blobId: string, mime: string): string {
  const safe = blobId.replace(/[^A-Za-z0-9_-]/g, '_');
  const extension = extensionForMime(mime);
  return extension ? `${safe}.${extension}` : safe;
}

/**
 * How many mounted components are showing each file. A bubble and the viewer
 * open on the same picture share one file, and the file goes when the LAST of
 * them lets go — not when the first does, which would blank the other.
 */
const holders = new Map<string, number>();

export function createMediaUri(bytes: Uint8Array, mime: string, blobId: string): MediaUri {
  const directory = new Directory(Paths.cache, DIRECTORY);
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, mediaFileName(blobId, mime));
  const name = file.uri;
  if ((holders.get(name) ?? 0) === 0) file.write(bytes);
  holders.set(name, (holders.get(name) ?? 0) + 1);
  let released = false;
  return {
    uri: file.uri,
    release() {
      if (released) return;
      released = true;
      const remaining = (holders.get(name) ?? 1) - 1;
      if (remaining > 0) {
        holders.set(name, remaining);
        return;
      }
      holders.delete(name);
      try {
        if (file.exists) file.delete();
      } catch (error) {
        logger.warn('[allo] a decrypted media file could not be removed', error);
      }
    },
  };
}
