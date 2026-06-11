/**
 * Resolve a chat `MediaItem` to a URL the display layer can render.
 *
 * Two cases, both returned through one hook so display components stay uniform:
 *   - Legacy / plaintext media (no `encrypted` flag): the URL is resolved
 *     synchronously from the item / Oxy services exactly as before — no fetch,
 *     no decryption, identical to today's behavior.
 *   - End-to-end-encrypted media (`encrypted === true`): the opaque ciphertext is
 *     downloaded and decrypted via `mediaCache` (React Query handles the async
 *     resource — caching, de-dup, loading + error — so no `useEffect` is needed),
 *     yielding a local decrypted `blob:`/`file://` URL.
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useOxy } from '@oxyhq/services';
import { getDecryptedMediaUrl, peekDecryptedMediaUrl } from '@/lib/mediaCache';
import { resolveMediaUrl } from '@/utils/uploadAttachment';
import type { MediaItem } from '@/stores/messagesStore';

/** Result of resolving a media item to a renderable URL. */
export interface ResolvedMediaUrl {
  /** Renderable URL, or '' until an encrypted item finishes decrypting. */
  url: string;
  /** True while an encrypted item is being downloaded + decrypted. */
  isLoading: boolean;
  /** True if decryption failed (wrong key, tampered blob, network error). */
  isError: boolean;
}

/** Stable React Query key for a decrypted-media resolution. */
function decryptedMediaQueryKey(item: MediaItem): unknown[] {
  return ['decrypted-media', item.id, item.url, item.encryptionKey];
}

/**
 * Resolve a single media item to a renderable URL. Plaintext items resolve
 * synchronously; encrypted items resolve via the decrypted-media cache.
 */
export function useDecryptedMediaUrl(item: MediaItem | undefined): ResolvedMediaUrl {
  const { oxyServices } = useOxy();

  const isEncrypted = !!item?.encrypted;

  // Plaintext fast path — identical to the historical synchronous resolution.
  const plainUrl = useMemo(() => {
    if (!item || isEncrypted) return '';
    return resolveMediaUrl(item.id, oxyServices, { url: item.url, variant: 'full' });
  }, [item, isEncrypted, oxyServices]);

  const query = useQuery({
    queryKey: item ? decryptedMediaQueryKey(item) : ['decrypted-media', 'none'],
    enabled: isEncrypted && !!item?.url && !!item?.encryptionKey,
    // Decrypted URLs are stable for the lifetime of the cache entry; never refetch.
    staleTime: Infinity,
    gcTime: Infinity,
    retry: 1,
    queryFn: async (): Promise<string> => {
      if (!item || !item.url || !item.encryptionKey || !item.mimeType) {
        throw new Error('useDecryptedMediaUrl: missing encrypted media fields');
      }
      return getDecryptedMediaUrl(item.id, item.url, {
        keyBase64: item.encryptionKey,
        mime: item.mimeType,
        size: item.fileSize ?? 0,
      });
    },
    // Seed from the module cache so a remount renders instantly without a flash.
    initialData: () => (item ? peekDecryptedMediaUrl(item.id) : undefined),
  });

  if (!item) {
    return { url: '', isLoading: false, isError: false };
  }
  if (!isEncrypted) {
    return { url: plainUrl, isLoading: false, isError: false };
  }
  return {
    url: query.data ?? '',
    isLoading: query.isLoading || query.isFetching,
    isError: query.isError,
  };
}
