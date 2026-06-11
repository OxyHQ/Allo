/**
 * Decrypted-media cache (Fase 1D).
 *
 * Resolves an end-to-end-encrypted media reference to a *plaintext* URL the
 * display layer can hand straight to `expo-image`, the video/audio player, or a
 * download. The flow is: download the opaque ciphertext blob → decrypt it in
 * memory with the per-blob key recovered from the E2E message body → expose the
 * DECRYPTED bytes locally.
 *
 *   - Web: a `blob:` object URL from a Blob of the decrypted bytes.
 *   - Native: a `file://` URI in the app cache directory holding the decrypted
 *     bytes (data URIs are avoided — large media as base64 is memory-heavy and
 *     can crash the bridge / image decoder).
 *
 * Security: decrypted bytes never leave the device and are never re-uploaded.
 * Native cache files live under a dedicated subfolder of the OS cache dir (which
 * the system may reclaim) and are removed by `clearDecryptedMediaCache()` on
 * logout. Resolutions are cached by `mediaId` and concurrent requests for the
 * same id are de-duplicated.
 */

import { Platform } from 'react-native';
import { File, Paths, Directory } from 'expo-file-system';
import { oxyClient } from '@oxyhq/core';
import { decryptMediaBlob, type MediaDecryptionKey } from '@/lib/mediaCrypto';

/** Subfolder of the OS cache directory holding decrypted media files (native). */
const DECRYPTED_CACHE_DIRNAME = 'allo-decrypted-media';

/** Maximum number of resolved entries kept in memory before pruning oldest. */
const MAX_CACHE_ENTRIES = 200;

/** A resolved entry: the local URL plus its native file handle (for cleanup). */
interface CacheEntry {
  url: string;
  /** Native temp file backing `url`, if any (so we can delete it on prune). */
  file: File | null;
  /** Web object URL backing `url`, if any (so we can revoke it on prune). */
  objectUrl: string | null;
  /** Insertion order timestamp for simple LRU-ish pruning. */
  at: number;
}

/** Resolved-by-mediaId cache. Module-level so it survives component re-renders. */
const resolved = new Map<string, CacheEntry>();

/** In-flight resolutions keyed by mediaId so concurrent callers share one fetch. */
const inFlight = new Map<string, Promise<string>>();

/** Lazily-created native cache directory handle. */
let cacheDir: Directory | null = null;

/** Resolve (creating if needed) the native decrypted-media cache directory. */
function getNativeCacheDir(): Directory {
  if (cacheDir) return cacheDir;
  const dir = new Directory(Paths.cache, DECRYPTED_CACHE_DIRNAME);
  if (!dir.exists) dir.create({ intermediates: true });
  cacheDir = dir;
  return dir;
}

/** Map a media id to a safe, collision-free native cache filename. */
function cacheFileNameFor(mediaId: string): string {
  const safe = mediaId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  return safe.length > 0 ? safe : `media-${Date.now()}`;
}

/**
 * Download the ciphertext bytes for a media URL. The URL is already absolute (an
 * Oxy CDN URL or the backend's root-mounted `/uploads/...`), so this uses a raw
 * authenticated fetch rather than the `/api`-prefixed axios client. The auth
 * token comes from the same Oxy client the rest of the app uses.
 */
async function downloadCiphertext(url: string): Promise<Uint8Array> {
  const token = oxyClient.getAccessToken();
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!response.ok) {
    throw new Error(`mediaCache: ciphertext download failed (${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/** Persist decrypted bytes to a native cache file and return its `file://` URI. */
function writeNativeCacheFile(mediaId: string, bytes: Uint8Array): { url: string; file: File } {
  const dir = getNativeCacheDir();
  const file = new File(dir, cacheFileNameFor(mediaId));
  if (file.exists) file.delete();
  file.create();
  file.write(bytes);
  return { url: file.uri, file };
}

/** Build a web `blob:` object URL from decrypted bytes. */
function writeWebObjectUrl(bytes: Uint8Array, mime: string): string {
  // Copy into a fresh ArrayBuffer so the Blob owns contiguous backing memory.
  const copy = bytes.slice();
  const blob = new Blob([copy], { type: mime });
  return URL.createObjectURL(blob);
}

/** Evict the oldest cache entries (and free their backing storage) past the cap. */
function pruneIfNeeded(): void {
  if (resolved.size <= MAX_CACHE_ENTRIES) return;
  const entries = Array.from(resolved.entries()).sort((a, b) => a[1].at - b[1].at);
  const overflow = resolved.size - MAX_CACHE_ENTRIES;
  for (let i = 0; i < overflow; i++) {
    const [id, entry] = entries[i];
    releaseEntry(entry);
    resolved.delete(id);
  }
}

/** Free the storage backing a single cache entry. */
function releaseEntry(entry: CacheEntry): void {
  try {
    if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
  } catch (error) {
    console.warn('[mediaCache] Failed to revoke object URL:', error);
  }
  try {
    if (entry.file && entry.file.exists) entry.file.delete();
  } catch (error) {
    console.warn('[mediaCache] Failed to delete cache file:', error);
  }
}

/**
 * Resolve an encrypted media reference to a local, decrypted URL. Returns the
 * cached URL immediately on a hit; otherwise downloads + decrypts once (shared
 * across concurrent callers) and caches the result.
 */
export async function getDecryptedMediaUrl(
  mediaId: string,
  ciphertextUrl: string,
  key: MediaDecryptionKey
): Promise<string> {
  const hit = resolved.get(mediaId);
  if (hit) return hit.url;

  const existing = inFlight.get(mediaId);
  if (existing) return existing;

  const task = (async (): Promise<string> => {
    const ciphertext = await downloadCiphertext(ciphertextUrl);
    const plaintext = decryptMediaBlob(ciphertext, key);

    let entry: CacheEntry;
    if (Platform.OS === 'web') {
      const objectUrl = writeWebObjectUrl(plaintext, key.mime);
      entry = { url: objectUrl, file: null, objectUrl, at: Date.now() };
    } else {
      const { url, file } = writeNativeCacheFile(mediaId, plaintext);
      entry = { url, file, objectUrl: null, at: Date.now() };
    }

    resolved.set(mediaId, entry);
    pruneIfNeeded();
    return entry.url;
  })();

  inFlight.set(mediaId, task);
  try {
    return await task;
  } finally {
    inFlight.delete(mediaId);
  }
}

/** Synchronously read an already-resolved decrypted URL, if present. */
export function peekDecryptedMediaUrl(mediaId: string): string | undefined {
  return resolved.get(mediaId)?.url;
}

/**
 * Seed the cache with a locally-available plaintext URL for a media id (e.g. the
 * original picked / recorded file the SENDER already holds), so its own optimistic
 * render skips the download+decrypt round-trip. The URL is treated as
 * caller-owned: it is NOT deleted/revoked on prune (only the entry is dropped).
 */
export function seedDecryptedMediaUrl(mediaId: string, localUrl: string): void {
  if (resolved.has(mediaId) || !localUrl) return;
  resolved.set(mediaId, { url: localUrl, file: null, objectUrl: null, at: Date.now() });
}

/**
 * Clear the entire decrypted-media cache and free all backing storage. Called on
 * logout / account switch so no decrypted bytes survive the session.
 */
export function clearDecryptedMediaCache(): void {
  for (const entry of resolved.values()) releaseEntry(entry);
  resolved.clear();
  inFlight.clear();
  try {
    const dir = new Directory(Paths.cache, DECRYPTED_CACHE_DIRNAME);
    if (dir.exists) dir.delete();
  } catch (error) {
    console.warn('[mediaCache] Failed to clear native cache directory:', error);
  }
  cacheDir = null;
}
