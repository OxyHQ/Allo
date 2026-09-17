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

export function useMediaUri(ref: MediaRef | undefined, mime: string, enabled = true): MediaUriState {
  const file = useMediaFile(enabled ? ref : undefined);
  const bytes = file.status === 'ready' ? file.bytes : undefined;
  const blobId = ref?.blobId;
  const [state, setState] = useState<{ key: string; uri: string }>({ key: '', uri: '' });

  useEffect(() => {
    if (!bytes || !blobId) {
      setState((prev) => (prev.uri === '' ? prev : { key: '', uri: '' }));
      return;
    }
    const handle = createMediaUri(bytes, mime, blobId);
    setState({ key: blobId, uri: handle.uri });
    return () => {
      handle.release();
    };
  }, [bytes, blobId, mime]);

  // Between a ref change and the effect that follows it, answer `''` rather
  // than the previous ref's URI.
  const uri = state.key === blobId ? state.uri : '';
  return { uri, loading: file.status === 'loading' || (bytes !== undefined && uri === ''), error: file.error };
}
