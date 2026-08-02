import type { MediaItem } from '@/stores';

/**
 * Oxy rendition variants are MIME-specific and 404 hard — there is no fallback,
 * and no single name serves both an image and a video. Measured against
 * `cloud.oxy.so` on 2026-08-02, one real image id and one real video id:
 *
 * | `?variant=`                 | image file | video file |
 * | --------------------------- | ---------- | ---------- |
 * | `thumb`, `w96`…`w2048`      | 302        | 404        |
 * | `poster`, `hls_master`      | 404        | 302        |
 * | omitted (the original)      | 302        | 302        |
 * | `full`, `large`, `original` | 404        | 404        |
 *
 * So the variant an attachment resolves with is a function of that item's kind,
 * and asking for the wrong one is indistinguishable from the file not existing:
 * the URL is well-formed, the renderer just gets a 404 body. `undefined` means
 * "send no `?variant=`", which serves the bytes as uploaded.
 *
 * Keyed by `MediaItem['type']` rather than switched on, so adding a media kind
 * is a compile error here instead of a silent 404 inside a chat bubble.
 */
const VARIANT_BY_MEDIA_KIND: Record<MediaItem['type'], string | undefined> = {
  // A bubble renders media at MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH (250pt) and an
  // AI message stretches to the window width, so 1280px covers the widest
  // surface at 3x without paying for a rendition nothing can display.
  image: 'w1280',
  // The carousel renders a video as a still frame, and `poster` is the only name
  // that resolves for a video today. Sized names for video are landing upstream;
  // do not switch to one before it is live.
  video: 'poster',
  // The original, so animation survives. A resized rendition is not guaranteed
  // to stay animated, and at 250pt a downscale buys nothing worth that risk.
  gif: undefined,
};

/**
 * The Oxy rendition variant to request for a message attachment of `kind`, for
 * passing straight to `oxyServices.getFileDownloadUrl`.
 */
export function mediaVariantForKind(kind: MediaItem['type']): string | undefined {
  return VARIANT_BY_MEDIA_KIND[kind];
}
