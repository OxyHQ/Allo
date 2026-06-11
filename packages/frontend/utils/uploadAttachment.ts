/**
 * Upload + URL-resolution helpers for chat attachments.
 *
 * Two upload modes:
 *   - PLAINTEXT (legacy / deviceless fallback): `uploadAttachment` prefers
 *     `oxyServices.assetUpload(...)` and falls back to the local backend
 *     `POST /api/messages/upload`. Used only when a chat has no encryptable
 *     recipient device (so end-to-end media is impossible).
 *   - ENCRYPTED (default for native chats, Fase 1D): `uploadEncryptedBlob`
 *     uploads an OPAQUE ciphertext blob (produced by `lib/mediaCrypto`) as
 *     `application/octet-stream` to the backend. The symmetric key never leaves
 *     the device — it rides inside the E2E message body.
 *
 * URLs are resolved lazily via `resolveMediaUrl` / the decrypted-media cache, so
 * callers only need to keep the media id (and, for encrypted media, the
 * ciphertext URL + key) stable.
 */
import { Platform } from 'react-native';
import { File } from 'expo-file-system';
import { oxyClient, type AssetUploadInput } from '@oxyhq/core';
import { API_URL } from '@/config';

/**
 * Minimal Oxy services surface this module relies on (avoids `any`). The method
 * signatures are loose enough that a full `OxyServices` instance is structurally
 * assignable.
 */
export interface OxyAssetServices {
  assetUpload?: (
    file: AssetUploadInput,
    visibility?: 'private' | 'public' | 'unlisted',
    metadata?: Record<string, unknown>,
    onProgress?: (progress: number) => void
  ) => Promise<unknown>;
  getFileDownloadUrl?: (id: string, variant?: string) => string;
}

export interface UploadedAsset {
  id: string;
  url?: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  fileSize?: number;
  mimeType?: string;
  fileName?: string;
  duration?: number;
  /** Tag indicating where the asset lives — used by getMediaUrl() */
  source: 'oxy' | 'backend';
}

export interface UploadInput {
  uri: string;
  name?: string;
  type?: string;
  size?: number;
  width?: number;
  height?: number;
  duration?: number;
}

/** Origin (no `/api` suffix) used to absolutize backend-relative upload URLs. */
function backendOrigin(): string {
  return API_URL.replace(/\/api\/?$/, '');
}

/** Absolutize a backend upload URL (`/uploads/...`) against the API origin. */
function absolutizeUploadUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return `${backendOrigin()}${url.startsWith('/') ? '' : '/'}${url}`;
}

const guessMimeFromName = (name?: string): string => {
  if (!name) return 'application/octet-stream';
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    aac: 'audio/aac',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
};

/**
 * Read the raw bytes of a local file URI, cross-platform.
 *   - Native: `expo-file-system`'s `File(uri).bytes()`.
 *   - Web: `fetch(uri)` then `arrayBuffer()` (handles `blob:`/`data:`/`http(s):`).
 */
export async function readFileBytes(uri: string): Promise<Uint8Array> {
  if (Platform.OS === 'web') {
    const response = await fetch(uri);
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }
  const file = new File(uri);
  return file.bytes();
}

/** Extract the uploaded file id from an Oxy `assetUpload` result of unknown shape. */
function extractUploadedFileId(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as { id?: unknown; file?: { id?: unknown } };
  if (typeof r.file?.id === 'string') return r.file.id;
  if (typeof r.id === 'string') return r.id;
  return null;
}

async function uploadViaOxy(
  input: UploadInput,
  oxyServices: OxyAssetServices | undefined
): Promise<UploadedAsset | null> {
  if (!oxyServices || typeof oxyServices.assetUpload !== 'function') {
    return null;
  }

  const fileName = input.name || input.uri.split('/').pop() || `file-${Date.now()}`;
  const mimeType = input.type || guessMimeFromName(fileName);

  try {
    let result: unknown;
    if (Platform.OS === 'web') {
      const blob = await fetch(input.uri).then((r) => r.blob());
      const file =
        typeof globalThis.File !== 'undefined'
          ? new globalThis.File([blob], fileName, { type: mimeType })
          : blob;
      result = await oxyServices.assetUpload(file, 'private');
    } else {
      result = await oxyServices.assetUpload(
        { uri: input.uri, name: fileName, type: mimeType, size: input.size },
        'private'
      );
    }

    const fileId = extractUploadedFileId(result);
    if (!fileId) return null;

    return {
      id: fileId,
      mimeType,
      fileName,
      fileSize: input.size,
      width: input.width,
      height: input.height,
      duration: input.duration,
      source: 'oxy',
    };
  } catch (error) {
    console.warn('[uploadAttachment] Oxy upload failed:', error);
    return null;
  }
}

/** Raw multipart POST of a Blob to the backend upload endpoint. */
async function postBlobToBackend(
  blob: Blob,
  fileName: string
): Promise<{ id: string; url: string; fileName?: string; mimeType?: string; size?: number } | null> {
  const formData = new FormData();
  formData.append('file', blob, fileName);

  const token = oxyClient.getAccessToken();
  const response = await fetch(`${API_URL}/messages/upload`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: formData,
  });
  if (!response.ok) {
    console.warn('[uploadAttachment] Backend upload failed with status:', response.status);
    return null;
  }
  const json = await response.json();
  const data = (json?.data || json) as
    | { id?: string; url?: string; fileName?: string; mimeType?: string; size?: number }
    | undefined;
  if (!data?.id || !data.url) return null;
  return {
    id: data.id,
    url: absolutizeUploadUrl(data.url),
    fileName: data.fileName,
    mimeType: data.mimeType,
    size: data.size,
  };
}

async function uploadViaBackend(input: UploadInput): Promise<UploadedAsset | null> {
  try {
    const fileName = input.name || input.uri.split('/').pop() || `file-${Date.now()}`;
    const mimeType = input.type || guessMimeFromName(fileName);

    let blob: Blob;
    if (Platform.OS === 'web') {
      blob = await fetch(input.uri).then((r) => r.blob());
    } else {
      const bytes = await readFileBytes(input.uri);
      blob = new Blob([bytes.slice()], { type: mimeType });
    }

    const data = await postBlobToBackend(blob, fileName);
    if (!data) return null;

    return {
      id: data.id,
      url: data.url,
      fileName: data.fileName || fileName,
      mimeType: data.mimeType || mimeType,
      fileSize: data.size,
      width: input.width,
      height: input.height,
      duration: input.duration,
      source: 'backend',
    };
  } catch (error) {
    console.warn('[uploadAttachment] Backend upload threw:', error);
    return null;
  }
}

/**
 * Upload a single PLAINTEXT attachment, preferring Oxy services when available.
 * Used only for the deviceless plaintext fallback — encrypted chats use
 * `uploadEncryptedBlob` instead.
 */
export async function uploadAttachment(
  input: UploadInput,
  oxyServices: OxyAssetServices | undefined
): Promise<UploadedAsset> {
  const oxyResult = await uploadViaOxy(input, oxyServices);
  if (oxyResult) return oxyResult;

  const backendResult = await uploadViaBackend(input);
  if (backendResult) return backendResult;

  throw new Error('Failed to upload attachment');
}

/** Result of uploading an encrypted (ciphertext) blob. */
export interface UploadedEncryptedBlob {
  /** Backend media id (also the on-disk filename). */
  id: string;
  /** Absolute URL of the uploaded ciphertext blob. */
  url: string;
}

/**
 * Upload an OPAQUE ciphertext blob (already encrypted by `lib/mediaCrypto`) to
 * the backend as `application/octet-stream`. The backend stores it with a `.bin`
 * extension and serves it with attachment + nosniff + sandbox headers; it never
 * sees the symmetric key. Returns the media id + absolute ciphertext URL.
 */
export async function uploadEncryptedBlob(
  ciphertext: Uint8Array,
  fileName: string
): Promise<UploadedEncryptedBlob> {
  // Copy into a fresh buffer so the Blob owns contiguous backing memory.
  const blob = new Blob([ciphertext.slice()], { type: 'application/octet-stream' });
  const data = await postBlobToBackend(blob, fileName);
  if (!data) {
    throw new Error('Failed to upload encrypted attachment');
  }
  return { id: data.id, url: data.url };
}

/**
 * Resolve a stored media id back to a download URL (PLAINTEXT media only).
 *   - If a backend URL was recorded on the MediaItem (`url`), return it absolute.
 *   - If the id itself is an absolute URL, return it as-is.
 *   - Otherwise fall back to `oxyServices.getFileDownloadUrl(id, variant)`.
 *
 * Encrypted media is NOT resolved here — it goes through the decrypted-media
 * cache (see `hooks/useDecryptedMediaUrl`).
 */
export function resolveMediaUrl(
  mediaId: string,
  oxyServices: OxyAssetServices | undefined,
  options?: { url?: string; variant?: string }
): string {
  if (options?.url) {
    return absolutizeUploadUrl(options.url);
  }

  if (mediaId.startsWith('http://') || mediaId.startsWith('https://')) {
    return mediaId;
  }

  try {
    if (oxyServices && typeof oxyServices.getFileDownloadUrl === 'function') {
      return oxyServices.getFileDownloadUrl(mediaId, options?.variant || 'full');
    }
    return '';
  } catch (error) {
    console.warn('[resolveMediaUrl] failed to resolve:', error);
    return '';
  }
}
