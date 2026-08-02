import {
  clampViewerIndex,
  collectViewerItems,
  selectViewerItem,
} from '@/lib/chat/attachmentViewer';
import type { MediaItem, Message } from '@/stores/messagesStore';

/**
 * What the full-screen viewer opens on.
 *
 * Three things carry it, and each one is a way the viewer can be wrong without
 * looking wrong. **It opens on the picture that was tapped** — an index off by
 * one shows the neighbour, which reads as the app choosing a different photo.
 * **It opens on the original and not on the thumbnail** — a viewer showing the
 * 1024px copy full screen looks like a viewer, just a soft one, and nothing on
 * screen says which copy it is. And **it is in timeline order**, because a
 * gallery that reorders the conversation puts the swipe somewhere the reader did
 * not come from.
 *
 * All of it against `Message`, which both backends fill, so none of it knows
 * whether it is looking at a Matrix room or the Express API.
 */

function message(id: string, media: MediaItem[] | undefined): Message {
  return {
    id,
    text: '',
    senderId: '@alice:allo.you',
    timestamp: new Date(1_700_000_000_000),
    isSent: false,
    conversationId: '!room:allo.you',
    media,
  };
}

/** A picture the sender made a thumbnail for: two refs, one row. */
function withThumbnail(id: string): MediaItem {
  return {
    id: `${id}:thumb`,
    type: 'image',
    fullSizeId: `${id}:full`,
    filename: `${id}.jpg`,
  };
}

/** A picture with no smaller copy: the row already draws the original. */
function original(id: string): MediaItem {
  return { id: `${id}:full`, type: 'image', filename: `${id}.jpg` };
}

describe('the gallery a viewer opens on', () => {
  it('collects every attachment in timeline order', () => {
    const items = collectViewerItems([
      message('m1', [withThumbnail('a')]),
      message('m2', undefined),
      message('m3', [withThumbnail('b')]),
    ]);

    expect(items.map((item) => item.mediaId)).toEqual(['a:full', 'b:full']);
  });

  it('spans the whole conversation and not the tapped message', () => {
    // A Matrix event carries one attachment, so five photographs are five
    // messages. A gallery scoped to one of them could never be swiped.
    const items = collectViewerItems([
      message('m1', [withThumbnail('a')]),
      message('m2', [withThumbnail('b')]),
      message('m3', [withThumbnail('c')]),
    ]);

    expect(items).toHaveLength(3);
  });

  it('opens on the original, which is the only thing full screen means', () => {
    const items = collectViewerItems([message('m1', [withThumbnail('a')])]);

    expect(items[0].mediaId).toBe('a:full');
  });

  it('keeps the thumbnail as the preview, so the wait is not a black screen', () => {
    // The thumbnail is already downloaded and already decrypted — the bubble
    // drew it. Showing it under the original costs nothing and covers a fetch
    // that on a slow connection is seconds long.
    const items = collectViewerItems([message('m1', [withThumbnail('a')])]);

    expect(items[0].previewId).toBe('a:thumb');
  });

  it('has no preview when the row was already showing the original', () => {
    // Otherwise the viewer would draw the same bytes twice, and ask the cache
    // for a ref that is the one it is already waiting on.
    const items = collectViewerItems([message('m1', [original('a')])]);

    expect(items[0].previewId).toBeUndefined();
    expect(items[0].mediaId).toBe('a:full');
  });

  it('carries the filename, which is what a share sheet is named after', () => {
    const items = collectViewerItems([message('m1', [withThumbnail('a')])]);

    expect(items[0].filename).toBe('a.jpg');
  });

  it('keeps a video in the gallery and says it is one', () => {
    const items = collectViewerItems([
      message('m1', [{ id: 'clip:thumb', type: 'video', fullSizeId: 'clip:full' }]),
    ]);

    expect(items).toEqual([
      expect.objectContaining({ kind: 'video', mediaId: 'clip:full' }),
    ]);
  });

  it('gives the same file sent twice two different pages', () => {
    // The Express path keys media on an Oxy file id, so sending one picture
    // twice produces the same id twice. A shared key would make React drop the
    // second page and a swipe would land on nothing.
    const items = collectViewerItems([
      message('m1', [original('a')]),
      message('m2', [original('a')]),
    ]);

    expect(items[0].key).not.toBe(items[1].key);
  });

  it('cannot confuse two different pairs for one page', () => {
    // A Matrix media ref is JSON and may contain any character, including the
    // separator. The message id cannot, which is why it goes first.
    const items = collectViewerItems([
      message('m1', [{ id: 'x#y', type: 'image' }]),
      message('m1#x', [{ id: 'y', type: 'image' }]),
    ]);

    expect(items[0].key).not.toBe(items[1].key);
  });
});

describe('which page a tap opens', () => {
  const messages = [
    message('m1', [withThumbnail('a')]),
    message('m2', [withThumbnail('b')]),
    message('m3', [withThumbnail('c')]),
  ];

  it('opens on the picture that was tapped', () => {
    expect(selectViewerItem(messages, 'm2', 'b:thumb')?.index).toBe(1);
  });

  it('opens on the first one when the first one was tapped', () => {
    expect(selectViewerItem(messages, 'm1', 'a:thumb')?.index).toBe(0);
  });

  it('opens on the last one when the last one was tapped', () => {
    expect(selectViewerItem(messages, 'm3', 'c:thumb')?.index).toBe(2);
  });

  it('gives the whole gallery, not just the page', () => {
    expect(selectViewerItem(messages, 'm2', 'b:thumb')?.items).toHaveLength(3);
  });

  it('needs the message as well as the media to find the page', () => {
    // Two messages can carry the same media id; the media alone would open the
    // first one, which is not the one the finger was on.
    const duplicated = [message('m1', [original('a')]), message('m2', [original('a')])];

    expect(selectViewerItem(duplicated, 'm2', 'a:full')?.index).toBe(1);
  });

  it('does not open at all on media that is no longer there', () => {
    // A message can be redacted between the render that drew it and the tap. A
    // viewer with no pages is a black screen the reader has to dismiss.
    expect(selectViewerItem(messages, 'm2', 'gone')).toBeUndefined();
  });

  it('does not open on a conversation with no attachments', () => {
    expect(selectViewerItem([message('m1', undefined)], 'm1', 'a')).toBeUndefined();
  });
});

describe('an index into a gallery that changed underneath it', () => {
  it('leaves a valid index alone', () => {
    expect(clampViewerIndex(1, 3)).toBe(1);
  });

  it('falls back to the last page rather than off the end', () => {
    // A redaction while the viewer is open shortens the gallery. Past the end
    // draws nothing at all.
    expect(clampViewerIndex(5, 3)).toBe(2);
  });

  it('never goes below the first page', () => {
    expect(clampViewerIndex(-2, 3)).toBe(0);
  });

  it('answers zero for an empty gallery rather than minus one', () => {
    expect(clampViewerIndex(4, 0)).toBe(0);
  });
});
