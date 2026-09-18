/**
 * The gallery a full-screen viewer pages through: every picture and video in
 * the loaded timeline, in order, one page per message.
 *
 * The page opens on the ORIGINAL — the only thing full screen means — and keeps
 * the sender's thumbnail as the preview drawn while the original downloads, so
 * the wait is not a black screen.
 */
import type { MediaRef, TimelineItemView } from '@allo/core';

export interface ViewerItem {
  /** The message id. One media per message, so it names the page. */
  readonly key: string;
  readonly kind: 'image' | 'video';
  readonly ref: MediaRef;
  readonly previewRef: MediaRef | undefined;
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
      previewRef: media.thumbnail?.ref,
      mime: media.mime,
      filename: media.filename,
    });
  }
  return out;
}

/** An index into a gallery that may have changed underneath it, kept in range. */
export function clampViewerIndex(index: number, count: number): number {
  if (count <= 0 || index < 0) return 0;
  return Math.min(index, count - 1);
}
