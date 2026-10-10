/**
 * A `MediaRef` → a URI a picture, a video or a player can open, or `''` while
 * there is not one yet.
 *
 * `useMediaFile` (from `@allo/react`) downloads and decrypts through the SDK
 * and keeps the bytes in the provider's LRU; this hook turns those bytes into
 * whatever the platform can display (`mediaSink.native.ts` writes a cache
 * file, `mediaSink.web.ts` mints an object URL) and releases it on unmount or
 * when the ref changes.
 *
 * `enabled` is how a bubble says "not yet": a voice note or a document is not
 * fetched until it is played or opened, and passing `undefined` to the SDK
 * hook is what keeps the download from starting.
 */
import { useEffect, useState } from 'react';
import { useMediaFile, type MediaRef } from '@allo/react';
import { createMediaUri } from './mediaSink';

export interface MediaUriState {
  /** `''` until the bytes are here. */
  uri: string;
  loading: boolean;
  error?: unknown;
}

export function useMediaUri(
  ref: MediaRef | undefined,
  mime: string,
  enabled = true,
): MediaUriState {
  const file = useMediaFile(enabled ? ref : undefined);
  const bytes = file.status === 'ready' ? file.bytes : undefined;
  const blobId = ref?.blobId;
  // The URI minted for one exact (bytes, blobId, mime), so the one returned is
  // always the one made for the CURRENT inputs: after a ref change, a mime
  // change, or the bytes going away (and being released by the cleanup below),
  // nothing stale or revoked is answered, without an effect resetting state.
  const [minted, setMinted] = useState<{
    bytes: Uint8Array;
    blobId: string;
    mime: string;
    uri: string;
  } | null>(null);

  useEffect(() => {
    if (!bytes || !blobId) return;
    const handle = createMediaUri(bytes, mime, blobId);
    // Minting writes a file or allocates an object URL, which must be released,
    // so it cannot happen during render; this effect IS the external system.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- stores the handle this effect created and its cleanup releases
    setMinted({ bytes, blobId, mime, uri: handle.uri });
    return () => {
      handle.release();
    };
  }, [bytes, blobId, mime]);

  const uri =
    minted && minted.bytes === bytes && minted.blobId === blobId && minted.mime === mime
      ? minted.uri
      : '';
  return {
    uri,
    loading: file.status === 'loading' || (bytes !== undefined && uri === ''),
    error: file.error,
  };
}
