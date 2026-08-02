import { useCallback, useSyncExternalStore } from 'react';

import { CHAT_BACKEND } from '@/lib/chat/backend';
import { mediaCache } from '@/lib/chat/mediaCache';
import type { AlloMediaRef, AlloUnsubscribe } from '@/lib/matrix/types';

/**
 * Attachments from the Matrix port, in the shape `MediaCarousel` already asks
 * for.
 *
 * The carousel's `getMediaUrl(id, kind)` is what this exists to answer. On the
 * Matrix path the `id` is not an Oxy Cloud file id but the port's own opaque
 * media ref (`AlloMediaRef`), so the `kind` is unused here: an Oxy rendition
 * variant is MIME-specific and has to be chosen — see `utils/mediaVariant.ts` —
 * while a Matrix attachment is a single blob in the homeserver's media
 * repository, fetched and decrypted whole. The two paths must not be mixed;
 * they resolve different identifiers against different servers.
 *
 * Answers `undefined` when this build talks to the Express API, so
 * `ConversationView` falls through to the resolver it has always used.
 */

const enabled = CHAT_BACKEND === 'matrix';

const NO_UNSUBSCRIBE: AlloUnsubscribe = () => {};
const subscribeToNothing = (): AlloUnsubscribe => NO_UNSUBSCRIBE;
const NOTHING: ReadonlyMap<AlloMediaRef, string> = new Map();
const nothingFetched = (): ReadonlyMap<AlloMediaRef, string> => NOTHING;

export interface MatrixMedia {
  /**
   * The local URI for an attachment, or `''` while it is still being fetched.
   *
   * `''` and not `undefined` because that is what the carousel's prop is typed
   * as, and because an empty URI is what already means "no picture here" to
   * every renderer downstream — `getMediaUrl` on the Express path answers the
   * same way when it cannot resolve one.
   *
   * **Asking is what starts the download.** Safe to call during render and on
   * every row; see `lib/chat/mediaCache.ts`.
   */
  readonly url: (ref: AlloMediaRef) => string;
}

export function useMatrixMedia(): MatrixMedia | undefined {
  const fetched = useSyncExternalStore(
    enabled ? mediaCache.subscribe : subscribeToNothing,
    enabled ? mediaCache.getSnapshot : nothingFetched,
    nothingFetched,
  );

  // Reads *through this render's snapshot* rather than straight off the cache,
  // which is what ties the resolver to the subscription: a picture that has
  // just finished downloading replaces the map, which replaces the resolver,
  // which redraws the rows holding it. A hit never reaches the cache at all.
  const url = useCallback(
    (ref: AlloMediaRef): string =>
      fetched.get(ref) ?? (enabled ? (mediaCache.url(ref) ?? '') : ''),
    [fetched],
  );

  return enabled ? { url } : undefined;
}
