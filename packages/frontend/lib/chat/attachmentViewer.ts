/**
 * Every picture and video in the loaded timeline, in order, one entry per
 * message: what a viewer can open.
 *
 * A page opens on the ORIGINAL, which is the only thing full screen means, and
 * an original exists only once it has been downloaded and decrypted — so the
 * viewer opens one entry at a time (`components/chat/media/MediaViewer.tsx`)
 * rather than handing Bloom's gallery a set of URIs it does not have yet.
 */
import type { MediaRef, TimelineItemView } from '@allo/core';

export interface ViewerItem {
  /** The message id. One media per message, so it names the page. */
  readonly key: string;
  readonly kind: 'image' | 'video';
  readonly ref: MediaRef;
  readonly mime: string;
  readonly filename: string;
}

export function collectViewerItems(items: readonly TimelineItemView[]): ViewerItem[] {
  const out: ViewerItem[] = [];
  for (const item of items) {
    if (item.content.kind !== 'media') continue;
    const media = item.content.media;
    if (media.kind !== 'image' && media.kind !== 'video') continue;
    out.push({
      key: item.id,
      kind: media.kind,
      ref: media.ref,
      mime: media.mime,
      filename: media.filename,
    });
  }
  return out;
}
