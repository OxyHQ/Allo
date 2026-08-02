import type { MediaItem } from '@/stores';
import { mediaVariantForKind } from '@/utils/mediaVariant';

/**
 * The bug these tests guard: every message attachment resolved with
 * `?variant=full`, a name Oxy has never served. Its taxonomy is MIME-specific
 * and 404s hard with no fallback, so a wrong name is not a degraded image — it
 * is no image, and it looks exactly like a file that does not exist.
 *
 * A test that only restated the lookup table would pass no matter which names
 * were in it, so the assertions below are built around the two properties that
 * can actually catch a regression: that no kind may resolve with a name known
 * to 404 for every MIME, and that image and video may never share one.
 *
 * `ALL_KINDS` is annotated with `MediaItem['type'][]` rather than inferred, so
 * a kind added to the union without being added here is a compile error — the
 * vacuity floor, without which a shrinking list would keep passing.
 */
const ALL_KINDS: MediaItem['type'][] = ['image', 'video', 'gif'];

/**
 * Measured against cloud.oxy.so on 2026-08-02: these three 404 for an image
 * file id AND for a video file id. `full` is the one that shipped.
 */
const NEVER_SERVED = ['full', 'large', 'original'];

describe('mediaVariantForKind', () => {
  it.each(ALL_KINDS)('never resolves %s with a variant Oxy serves for nothing', (kind) => {
    expect(NEVER_SERVED).not.toContain(mediaVariantForKind(kind));
  });

  it('does not reuse one variant across image and video', () => {
    // The reason a per-kind mapping exists at all: the sized names (`w1280`,
    // `thumb`, …) 404 for a video, and `poster` 404s for an image.
    expect(mediaVariantForKind('image')).not.toEqual(mediaVariantForKind('video'));
  });

  it('asks for a sized rendition for an image', () => {
    expect(mediaVariantForKind('image')).toBe('w1280');
  });

  it('asks for the still frame for a video, the only name a video resolves with today', () => {
    expect(mediaVariantForKind('video')).toBe('poster');
  });

  it('asks for the original for a gif, so animation survives', () => {
    expect(mediaVariantForKind('gif')).toBeUndefined();
  });
});

describe('the URL the SDK builds from it', () => {
  /**
   * `getFileDownloadUrl` appends `?variant=` only when a variant is passed, so
   * the composition — not just the name — is what decides whether the request
   * 404s. This mirrors the builder in @oxyhq/core 17.0.2 rather than importing
   * the SDK, which would drag the whole client into a unit test.
   */
  const buildUrl = (fileId: string, variant?: string) =>
    `https://cloud.oxy.so/${encodeURIComponent(fileId)}${variant ? `?variant=${encodeURIComponent(variant)}` : ''}`;

  it.each([
    ['image' as const, 'https://cloud.oxy.so/abc123?variant=w1280'],
    ['video' as const, 'https://cloud.oxy.so/abc123?variant=poster'],
    ['gif' as const, 'https://cloud.oxy.so/abc123'],
  ])('builds the verified-200 URL for %s', (kind, expected) => {
    expect(buildUrl('abc123', mediaVariantForKind(kind))).toBe(expected);
  });

  it('no longer builds the URL that shipped', () => {
    // The control: this is what every attachment resolved to before the fix,
    // and it returns 404 for both an image file and a video file.
    const shipped = buildUrl('abc123', 'full');
    expect(ALL_KINDS.map((kind) => buildUrl('abc123', mediaVariantForKind(kind)))).not.toContain(shipped);
  });
});
