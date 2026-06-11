/**
 * Download a remote file to a local cache URI (F2.6).
 *
 * Used to bring a remote asset (e.g. a Klipy GIF) onto the device so it can flow
 * through the standard outgoing-media pipeline — which encrypts the LOCAL bytes
 * once and uploads only the ciphertext. Hotlinking the remote URL would leak the
 * recipient set to the third party and defeat E2E, so GIFs are always downloaded
 * first and sent as a normal encrypted media blob.
 *
 *   - Web: returns the original URL. `readFileBytes` fetches `http(s):` URLs
 *     directly on web, so no intermediate file is needed.
 *   - Native: streams the URL into a file under the OS cache directory and
 *     returns its `file://` URI for `readFileBytes` (which only reads local
 *     files on native).
 */

import { Platform } from 'react-native';
import { File, Paths, Directory } from 'expo-file-system';

/** Subfolder of the OS cache directory holding downloaded outgoing assets. */
const OUTGOING_CACHE_DIRNAME = 'allo-outgoing-cache';

/** Lazily-created native cache directory handle. */
let cacheDir: Directory | null = null;

/** Resolve (creating if needed) the native outgoing-asset cache directory. */
function getCacheDir(): Directory {
  if (cacheDir) return cacheDir;
  const dir = new Directory(Paths.cache, OUTGOING_CACHE_DIRNAME);
  if (!dir.exists) dir.create({ intermediates: true });
  cacheDir = dir;
  return dir;
}

/** Build a safe, collision-resistant cache filename for a download. */
function cacheFileNameFor(suggestedName: string): string {
  const safe = suggestedName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  const base = safe.length > 0 ? safe : `asset-${Date.now()}`;
  return `${Date.now()}-${base}`;
}

/**
 * Download `url` to a local file and return its `file://` URI (native) or the
 * original URL (web). `suggestedName` seeds the cache filename. Throws on a
 * non-2xx response so callers can surface a send error rather than encrypting
 * an empty file.
 */
export async function downloadToCache(url: string, suggestedName: string): Promise<string> {
  if (Platform.OS === 'web') {
    return url;
  }
  const dir = getCacheDir();
  const file = new File(dir, cacheFileNameFor(suggestedName));
  if (file.exists) file.delete();
  const downloaded = await File.downloadFileAsync(url, file);
  return downloaded.uri;
}
