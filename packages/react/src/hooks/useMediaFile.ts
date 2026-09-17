import type { MediaRef } from "@allo/core";
import { useEffect, useMemo, useState } from "react";
import { useAlloContext } from "../AlloProvider";
import { mediaKey, type MediaCache } from "../mediaCache";

export type MediaFileStatus = "idle" | "loading" | "ready" | "error";

export interface MediaFile {
  status: MediaFileStatus;
  /** The decrypted bytes once `ready`: the same reference for every consumer of the same ref while cached. */
  bytes?: Uint8Array;
  error?: unknown;
}

const IDLE: MediaFile = { status: "idle" };
const LOADING: MediaFile = { status: "loading" };

function fromCache(cache: MediaCache, key: string | null): MediaFile {
  if (key === null) return IDLE;
  const bytes = cache.get(key);
  return bytes ? { status: "ready", bytes } : LOADING;
}

/**
 * Downloads and decrypts a media blob through `client.media.download`, served
 * from the provider's LRU when already fetched. A ref change or unmount
 * detaches the hook from an in-flight download (its result still fills the
 * cache, so the next mount is instant). `undefined` means `idle`.
 */
export function useMediaFile(ref: MediaRef | undefined): MediaFile {
  const { client, mediaCache } = useAlloContext();
  const key = ref ? mediaKey(ref) : null;
  const conversationId = ref?.conversationId;
  const blobId = ref?.blobId;

  const [snapshot, setSnapshot] = useState<{ key: string | null; file: MediaFile }>(() => ({ key, file: fromCache(mediaCache, key) }));

  useEffect(() => {
    if (key === null || conversationId === undefined || blobId === undefined) {
      setSnapshot({ key: null, file: IDLE });
      return;
    }
    let cancelled = false;
    const cached = mediaCache.get(key);
    if (cached) {
      setSnapshot({ key, file: { status: "ready", bytes: cached } });
      return;
    }
    setSnapshot({ key, file: LOADING });
    mediaCache.load(key, () => client.media.download({ conversationId, blobId })).then(
      (bytes) => {
        if (!cancelled) setSnapshot({ key, file: { status: "ready", bytes } });
      },
      (error: unknown) => {
        if (!cancelled) setSnapshot({ key, file: { status: "error", error } });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, mediaCache, key, conversationId, blobId]);

  // Between a ref change and the effect that follows it, answer from the cache rather than with the previous ref's state.
  const stale = snapshot.key !== key;
  return useMemo(() => (stale ? fromCache(mediaCache, key) : snapshot.file), [stale, mediaCache, key, snapshot.file]);
}
