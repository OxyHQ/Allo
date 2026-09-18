import type { MediaView, TimelineItemView } from '@allo/core';

import { clampViewerIndex, collectViewerItems } from '@/lib/chat/attachmentViewer';

function media(id: string, overrides: Partial<MediaView> = {}): TimelineItemView {
  return {
    id,
    conversationId: 'conv',
    seq: 1,
    senderAccountId: 'acc',
    senderInstanceId: null,
    sentAt: '2026-09-17T10:00:00.000Z',
    isOwn: false,
    sendState: 'accepted',
    reactions: [],
    content: {
      kind: 'media',
      media: {
        kind: 'image',
        filename: `${id}.jpg`,
        mime: 'image/jpeg',
        size: 10,
        ref: { conversationId: 'conv', blobId: `blob-${id}` },
        ...overrides,
      },
    },
  };
}

const text: TimelineItemView = {
  ...media('t'),
  content: { kind: 'text', body: 'hi', isEdited: false },
};

describe('the gallery a viewer opens on', () => {
  it('collects every picture and video in timeline order, one page per message', () => {
    const items = collectViewerItems([media('a'), text, media('b', { kind: 'video', mime: 'video/mp4' })]);
    expect(items.map((item) => [item.key, item.kind])).toEqual([
      ['a', 'image'],
      ['b', 'video'],
    ]);
  });

  it('opens on the original and keeps the thumbnail as the preview', () => {
    const thumbnail = { ref: { conversationId: 'conv', blobId: 'thumb' }, width: 10, height: 10 };
    const [item] = collectViewerItems([media('a', { thumbnail })]);
    expect(item.ref.blobId).toBe('blob-a');
    expect(item.previewRef?.blobId).toBe('thumb');
  });

  it('leaves out what a viewer cannot show', () => {
    expect(collectViewerItems([media('v', { kind: 'voice', mime: 'audio/m4a' }), media('f', { kind: 'file' })])).toEqual([]);
  });
});

describe('an index into a gallery that changed underneath it', () => {
  it('keeps a valid index, clamps past the end, never goes below zero', () => {
    expect(clampViewerIndex(1, 3)).toBe(1);
    expect(clampViewerIndex(5, 3)).toBe(2);
    expect(clampViewerIndex(-1, 3)).toBe(0);
    expect(clampViewerIndex(0, 0)).toBe(0);
  });
});
