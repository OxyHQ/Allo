import type { TimelineContent } from '@allo/core';
import type { MessageMediaFit } from '@oxy.so/bloom/message-bubble';

/** The content kinds whose blocks carry no padding of their own. */
const INSET_KINDS: ReadonlySet<TimelineContent['kind']> = new Set<TimelineContent['kind']>([
  'poll',
  'location',
  'contact',
]);

/**
 * How a bubble fits the block `MessageMedia` draws for this content.
 *
 * Only a picture or a video bleeds to the bubble's radius. A voice note, an
 * audio file and a document are a row of controls, and a poll, a place and a
 * card are typography: bled, the play button sat on the bubble's left edge and
 * the time pill landed on the waveform, as the first Android voice note did.
 * A sticker is its own shape and gets no bubble at all.
 */
export function messageMediaFit(content: TimelineContent | undefined): MessageMediaFit | undefined {
  if (!content) return undefined;
  if (content.kind === 'sticker') return 'bare';
  if (INSET_KINDS.has(content.kind)) return 'inset';
  if (
    content.kind === 'media' &&
    content.media.kind !== 'image' &&
    content.media.kind !== 'video'
  ) {
    return 'inset';
  }
  return undefined;
}
