import type { MediaView, TimelineContent } from '@allo/core';

import { messageMediaFit } from '@/lib/chat/mediaFit';

function media(kind: MediaView['kind']): TimelineContent {
  return {
    kind: 'media',
    media: {
      kind,
      filename: 'f',
      mime: 'application/octet-stream',
      size: 10,
      ref: { conversationId: 'conv', blobId: 'blob' },
    },
  };
}

describe('how a bubble fits its media', () => {
  it('lets only a picture or a video bleed to the radius', () => {
    expect(messageMediaFit(media('image'))).toBeUndefined();
    expect(messageMediaFit(media('video'))).toBeUndefined();
  });

  it('keeps the padding round a voice note, an audio file and a document', () => {
    // Bled, the play button sat on the bubble's edge and the time pill on the waveform.
    expect(messageMediaFit(media('voice'))).toBe('inset');
    expect(messageMediaFit(media('audio'))).toBe('inset');
    expect(messageMediaFit(media('file'))).toBe('inset');
  });

  it('keeps it round typography and draws no bubble round a sticker', () => {
    expect(messageMediaFit({ kind: 'poll' } as TimelineContent)).toBe('inset');
    expect(messageMediaFit({ kind: 'location' } as TimelineContent)).toBe('inset');
    expect(messageMediaFit({ kind: 'contact' } as TimelineContent)).toBe('inset');
    expect(messageMediaFit({ kind: 'sticker' } as TimelineContent)).toBe('bare');
    expect(messageMediaFit({ kind: 'text', body: 'hi', isEdited: false })).toBeUndefined();
  });
});
