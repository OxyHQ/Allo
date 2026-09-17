import type { MediaRef } from '@allo/core';
import type { MediaItem, Message } from '@/lib/chat/model';

/**
 * What the full-screen viewer opens on, worked out from the messages a screen
 * already has.
 *
 * Everything here reads `Message.media` and nothing else — no blob ids are
 * parsed and no server is named. The only thing that turns a `MediaRef` into
 * bytes is the SDK, through `lib/allo/useMediaUri.ts`.
 *
 * Pure, and separate from the component for that reason: what the gallery
 * contains and where it opens are the two things worth being sure about, and
 * both are decided here where they can be tested without a renderer.
 */

/** One page of the viewer. */
export interface ViewerItem {
  /**
   * Identity of this page, unique within one gallery.
   *
   * Built from the message and the media, not from the media alone: the same
   * file sent twice is the same blob id twice, and a duplicated React key
   * makes the second copy disappear.
   */
  readonly key: string;
  readonly kind: MediaItem['type'];
  /** The full-size original. What the viewer asks the SDK for. */
  readonly ref: MediaRef;
  /**
   * The smaller copy the bubble already drew, when there is one.
   *
   * Shown underneath while the original downloads, which on an encrypted
   * conversation is a fetch and a decryption. Without it the viewer would open
   * on black — the thumbnail is already decrypted and in the cache, so drawing
   * it costs nothing and covers the wait.
   */
  readonly previewRef: MediaRef | undefined;
  readonly mime: string;
  /** For the share sheet. Absent for an attachment whose sender did not say. */
  readonly filename: string | undefined;
}

/** A gallery, and the page it opens on. */
export interface ViewerSelection {
  readonly items: readonly ViewerItem[];
  /** Always a valid index into {@link items}. */
  readonly index: number;
}

/**
 * Every attachment in these messages that the viewer can show, oldest first.
 *
 * The whole conversation and not the tapped message: five photographs sent one
 * at a time are five messages, and a viewer scoped to one message could never
 * be swiped. Timeline order is the messages' own — nothing is sorted here.
 */
export function collectViewerItems(messages: readonly Message[]): ViewerItem[] {
  const items: ViewerItem[] = [];
  for (const message of messages) {
    for (const media of message.media ?? []) {
      items.push({
        key: viewerKey(message.id, media.id),
        kind: media.type,
        ref: media.ref,
        previewRef: media.thumbnailRef,
        mime: media.mime,
        filename: media.filename,
      });
    }
  }
  return items;
}

/**
 * The gallery to open when this media in this message was tapped, or
 * `undefined` when there is nothing to open.
 *
 * `undefined` rather than an empty gallery on purpose: a viewer with no pages
 * is a black screen the user has to dismiss, and the honest response to a tap
 * on something that is no longer there is not to open at all. It happens — a
 * message can be deleted between the render that drew it and the tap.
 */
export function selectViewerItem(
  messages: readonly Message[],
  messageId: string,
  mediaId: string,
): ViewerSelection | undefined {
  const items = collectViewerItems(messages);
  const key = viewerKey(messageId, mediaId);
  const index = items.findIndex((item) => item.key === key);
  return index === -1 ? undefined : { items, index };
}

/**
 * A key that no other pair can produce.
 *
 * Length-prefixed rather than separated by a character, and that is the whole
 * point: a media id is opaque and may contain any character at all, so *every*
 * separator appears in some legitimate id. With a
 * plain `a + '#' + b`, the pair `('m1', 'x#y')` and the pair `('m1#x', 'y')`
 * both spell `m1#x#y`, and a duplicated React key makes one of the two pages
 * disappear. The length says exactly where the first half ends, so the decoding
 * is unambiguous for any two strings whatsoever.
 */
function viewerKey(messageId: string, mediaId: string): string {
  return `${messageId.length}#${messageId}${mediaId}`;
}

/**
 * Keeps an index inside a gallery that has changed underneath it.
 *
 * The gallery is a snapshot taken when the viewer opened, but the viewer stays
 * open while the conversation keeps arriving, and a deletion shortens the
 * list. An index past the end draws nothing at all; clamping shows the last
 * picture instead, which is the closest true answer.
 */
export function clampViewerIndex(index: number, count: number): number {
  if (count <= 0) {
    return 0;
  }
  if (index < 0) {
    return 0;
  }
  return index > count - 1 ? count - 1 : index;
}
