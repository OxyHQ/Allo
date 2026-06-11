/**
 * Prepare outgoing chat media for send (Fase 1D).
 *
 * Given the media items a producer (picker / camera / voice note / forward)
 * attached — each carrying a local source URI — this either:
 *   - ENCRYPTS each blob once with a fresh key, uploads the ciphertext, and
 *     returns `MediaRef`s (key-bearing, for the E2E message body) plus display
 *     `MediaItem`s pointing at the ciphertext URL; or
 *   - uploads the PLAINTEXT blob (deviceless fallback) and returns plain
 *     `MediaItem`s with no key material.
 *
 * The symmetric keys never leave the device in the encrypted path — they are
 * embedded only in the E2E-encrypted message body by the caller.
 */

import { encryptMediaBlob } from '@/lib/mediaCrypto';
import {
  readFileBytes,
  uploadEncryptedBlob,
  uploadAttachment,
  type OxyAssetServices,
} from '@/utils/uploadAttachment';
import { getDecryptedMediaUrl } from '@/lib/mediaCache';
import type { MediaItem } from '@/stores/messagesStore';
import type { MediaRef, MediaRefType } from '@/lib/mediaPayload';

/** A media item augmented with the local plaintext source needed to encrypt it. */
export interface OutgoingMediaSource extends MediaItem {
  /** Local file URI of the PLAINTEXT source (the picked / recorded / cached file). */
  localUri?: string;
}

/** Result of preparing media for the ENCRYPTED send path. */
export interface PreparedEncryptedMedia {
  /** Key-bearing refs to embed inside the E2E message body. */
  mediaRefs: MediaRef[];
  /** Display items (ciphertext URL + key) for optimistic + post-send rendering. */
  mediaItems: MediaItem[];
}

/** Map a MediaItem.type to the MediaRef.type union (identical members). */
function toMediaRefType(type: MediaItem['type']): MediaRefType {
  return type;
}

/** Resolve the best MIME type for a media source, with a type-based fallback. */
function resolveMime(source: OutgoingMediaSource): string {
  if (source.mimeType && source.mimeType.length > 0) return source.mimeType;
  switch (source.type) {
    case 'image':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'video':
      return 'video/mp4';
    case 'audio':
      return 'audio/mp4';
    default:
      return 'application/octet-stream';
  }
}

/** Stable filename for an uploaded ciphertext blob (extension derives server-side). */
function ciphertextFileName(source: OutgoingMediaSource): string {
  const base = source.fileName?.replace(/\.[^./]+$/, '') || source.id || `media-${Date.now()}`;
  return `${base}.bin`;
}

/**
 * Encrypt + upload every media source for the E2E path. Each source must carry a
 * `localUri` (the plaintext file on device). Throws if any source can't be read,
 * encrypted or uploaded — media must never silently fall back to plaintext in an
 * encrypted chat.
 */
export async function prepareEncryptedMedia(
  sources: OutgoingMediaSource[]
): Promise<PreparedEncryptedMedia> {
  const mediaRefs: MediaRef[] = [];
  const mediaItems: MediaItem[] = [];

  for (const source of sources) {
    if (!source.localUri) {
      throw new Error(`prepareEncryptedMedia: media ${source.id} is missing a local source`);
    }
    const mime = resolveMime(source);
    const bytes = await readFileBytes(source.localUri);
    const encrypted = encryptMediaBlob(bytes, mime);
    const uploaded = await uploadEncryptedBlob(encrypted.ciphertext, ciphertextFileName(source));

    const ref: MediaRef = {
      mediaId: uploaded.id,
      url: uploaded.url,
      key: encrypted.keyBase64,
      mime,
      size: encrypted.size,
      type: toMediaRefType(source.type),
    };
    if (source.fileName) ref.fileName = source.fileName;
    if (source.width !== undefined) ref.width = source.width;
    if (source.height !== undefined) ref.height = source.height;
    if (source.duration !== undefined) ref.duration = source.duration;
    mediaRefs.push(ref);

    mediaItems.push({
      id: uploaded.id,
      type: source.type,
      url: uploaded.url,
      encrypted: true,
      encryptionKey: encrypted.keyBase64,
      mimeType: mime,
      fileName: source.fileName,
      fileSize: encrypted.size,
      width: source.width,
      height: source.height,
      duration: source.duration,
    });
  }

  return { mediaRefs, mediaItems };
}

/**
 * Convert stored message media items into send-ready sources for FORWARDING.
 *   - Encrypted source: decrypt it to a local plaintext URL (via the cache) and
 *     strip the original key/ciphertext URL so the store re-encrypts a FRESH key
 *     for the destination conversation (forwarding must not reuse keys/URLs).
 *   - Plaintext source: passed through unchanged (it has a public `url`).
 */
export async function toForwardSources(items: MediaItem[]): Promise<OutgoingMediaSource[]> {
  const sources: OutgoingMediaSource[] = [];
  for (const item of items) {
    if (item.encrypted && item.url && item.encryptionKey) {
      // The blob's AEAD binds the EXACT plaintext mime + byte size. Both must be
      // reproduced verbatim to decrypt; substituting defaults (e.g. size 0 or
      // octet-stream) would silently fail tag verification and surface as opaque
      // corruption. If either is missing the item is unforwardable — fail loudly
      // so the forward UI's catch shows the error instead of a broken attachment.
      if (typeof item.fileSize !== 'number' || item.fileSize <= 0) {
        throw new Error(`Cannot forward encrypted media ${item.id}: missing original size`);
      }
      if (!item.mimeType) {
        throw new Error(`Cannot forward encrypted media ${item.id}: missing original MIME type`);
      }
      const localUri = await getDecryptedMediaUrl(item.id, item.url, {
        keyBase64: item.encryptionKey,
        mime: item.mimeType,
        size: item.fileSize,
      });
      sources.push({
        id: item.id,
        type: item.type,
        localUri,
        fileName: item.fileName,
        mimeType: item.mimeType,
        fileSize: item.fileSize,
        width: item.width,
        height: item.height,
        duration: item.duration,
      });
    } else {
      // Plaintext attachment: forward the existing public URL as-is.
      sources.push({ ...item });
    }
  }
  return sources;
}

/**
 * Upload every media source as PLAINTEXT (deviceless fallback). Sources without a
 * `localUri` but with an existing `url` (already-uploaded plaintext, e.g. a
 * forwarded plaintext attachment) are passed through unchanged.
 */
export async function preparePlaintextMedia(
  sources: OutgoingMediaSource[],
  oxyServices: OxyAssetServices | undefined
): Promise<MediaItem[]> {
  const items: MediaItem[] = [];
  for (const source of sources) {
    if (!source.localUri) {
      // Already-uploaded plaintext (no local source to (re)upload) — pass through.
      const { localUri: _localUri, ...rest } = source;
      void _localUri;
      items.push(rest);
      continue;
    }
    const uploaded = await uploadAttachment(
      {
        uri: source.localUri,
        name: source.fileName,
        type: source.mimeType,
        size: source.fileSize,
        width: source.width,
        height: source.height,
        duration: source.duration,
      },
      oxyServices
    );
    items.push({
      id: uploaded.id,
      type: source.type,
      url: uploaded.url,
      mimeType: uploaded.mimeType,
      fileName: uploaded.fileName,
      fileSize: uploaded.fileSize,
      width: uploaded.width ?? source.width,
      height: uploaded.height ?? source.height,
      duration: uploaded.duration ?? source.duration,
    });
  }
  return items;
}
