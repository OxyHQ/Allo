/**
 * A status update's picture → a URI something can display, or `''`.
 *
 * The same shape as `useMediaUri`, with one difference that matters: a
 * status's key lives only in the decrypted envelope the SDK holds in memory,
 * never in the media-key store, because a status expires and a key that
 * outlived it would be a loose end. So this asks the SDK for the BYTES
 * (`client.statuses.media`) rather than handing a `MediaRef` to the media
 * cache.
 *
 * Nothing is fetched until a status is actually opened: a row of rings
 * downloads no pictures.
 */
import { useEffect, useState } from 'react';
import { useAlloClient } from '@allo/react';
import { createMediaUri } from './mediaSink';
import { logger } from '@/utils/logger';

export interface StatusMediaState {
  /** `''` until the bytes are here. */
  uri: string;
  loading: boolean;
  error?: unknown;
}

export function useStatusMedia(statusId: string | undefined, enabled = true): StatusMediaState {
  const client = useAlloClient();
  const [state, setState] = useState<{ key: string; uri: string; loading: boolean; error?: unknown }>({
    key: '',
    uri: '',
    loading: false,
  });

  useEffect(() => {
    if (!statusId || !enabled) {
      setState((prev) => (prev.uri === '' && !prev.loading ? prev : { key: '', uri: '', loading: false }));
      return;
    }
    const abort = new AbortController();
    let handle: { uri: string; release: () => void } | null = null;
    let cancelled = false;
    setState({ key: statusId, uri: '', loading: true });

    void client.statuses
      .media(statusId, { signal: abort.signal })
      .then((bytes) => {
        if (cancelled) return;
        handle = createMediaUri(bytes, 'image/jpeg', statusId);
        setState({ key: statusId, uri: handle.uri, loading: false });
      })
      .catch((error: unknown) => {
        if (cancelled || abort.signal.aborted) return;
        logger.debug('[status] media could not be opened', error);
        setState({ key: statusId, uri: '', loading: false, error });
      });

    return () => {
      cancelled = true;
      abort.abort();
      handle?.release();
    };
  }, [client, enabled, statusId]);

  // Between a change of status and the effect that follows it, answer `''`
  // rather than the previous one's picture.
  const uri = state.key === statusId ? state.uri : '';
  return { uri, loading: state.key === statusId && state.loading, error: state.error };
}
