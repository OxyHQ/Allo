import type { ConversationView, TimelineItemView } from '@allo/core';

import { conversationFromView, messageFromItem, previewOf, PLACEHOLDER_TEXT } from '@/lib/chat/model';

/**
 * The projection from what the SDK reports to what a screen draws. Pure, and
 * the place a wrong mapping would be invisible on screen: a `read` message
 * drawn as `sent` is one tick instead of two, and nobody files a bug about a
 * tick.
 */

function item(overrides: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id: 'evt-1',
    conversationId: 'conv-1',
    seq: 3,
    senderAccountId: 'acc-alice',
    senderInstanceId: 'inst-1',
    sentAt: '2026-09-17T10:00:00.000Z',
    isOwn: false,
    sendState: 'accepted',
    content: { kind: 'text', body: 'hello', isEdited: false },
    reactions: [],
    ...overrides,
  };
}

describe('messageFromItem', () => {
  it('maps a text item', () => {
    const message = messageFromItem(item());
    expect(message).toMatchObject({
      id: 'evt-1',
      text: 'hello',
      senderId: 'acc-alice',
      isSent: false,
      conversationId: 'conv-1',
      isEdited: false,
      messageType: 'user',
    });
    expect(message.timestamp.toISOString()).toBe('2026-09-17T10:00:00.000Z');
    // Status marks are the sender's own; an incoming message has none.
    expect(message.readStatus).toBeUndefined();
  });

  it('maps every send state of an own message to the mark the bubble draws', () => {
    const states = { pending: 'pending', accepted: 'sent', delivered: 'delivered', read: 'read', failed: 'failed' } as const;
    for (const [sendState, readStatus] of Object.entries(states)) {
      expect(messageFromItem(item({ isOwn: true, sendState: sendState as TimelineItemView['sendState'] })).readStatus).toBe(readStatus);
    }
  });

  it('turns a picture into a media item with its refs and a video into one that says so', () => {
    const picture = messageFromItem(
      item({
        content: {
          kind: 'media',
          media: {
            kind: 'image',
            filename: 'a.jpg',
            mime: 'image/jpeg',
            size: 10,
            width: 100,
            height: 50,
            caption: 'look',
            ref: { conversationId: 'conv-1', blobId: 'blob-a' },
            thumbnail: { ref: { conversationId: 'conv-1', blobId: 'blob-a-thumb' }, width: 10, height: 5 },
          },
        },
      }),
    );
    expect(picture.text).toBe('look');
    expect(picture.media).toEqual([
      expect.objectContaining({
        id: 'blob-a',
        type: 'image',
        ref: { conversationId: 'conv-1', blobId: 'blob-a' },
        thumbnailRef: { conversationId: 'conv-1', blobId: 'blob-a-thumb' },
        mime: 'image/jpeg',
        filename: 'a.jpg',
      }),
    ]);
    expect(picture.attachment).toBeUndefined();

    const gif = messageFromItem(item({ content: { kind: 'media', media: { kind: 'image', filename: 'x.gif', mime: 'image/gif', size: 1, ref: { conversationId: 'conv-1', blobId: 'g' } } } }));
    expect(gif.media?.[0].type).toBe('gif');
  });

  it('turns a voice note, an audio file and a document into an attachment, not media', () => {
    for (const kind of ['voice', 'audio', 'file'] as const) {
      const message = messageFromItem(
        item({ content: { kind: 'media', media: { kind, filename: 'n', mime: 'audio/mp4', size: 7, durationMs: 1200, ref: { conversationId: 'conv-1', blobId: 'b' } } } }),
      );
      expect(message.media).toBeUndefined();
      expect(message.attachment).toEqual({ kind, ref: { conversationId: 'conv-1', blobId: 'b' }, mime: 'audio/mp4', filename: 'n', size: 7, durationMs: 1200 });
    }
  });

  it('gives deleted and undecryptable items a placeholder body and a flag', () => {
    const deleted = messageFromItem(item({ content: { kind: 'deleted' } }));
    expect(deleted.text).toBe(PLACEHOLDER_TEXT.deleted);
    expect(deleted.isDeleted).toBe(true);

    const opaque = messageFromItem(item({ content: { kind: 'undecryptable', reason: 'no key' } }));
    expect(opaque.text).toBe(PLACEHOLDER_TEXT.undecryptable);
    expect(opaque.isUndecryptable).toBe(true);
  });

  it('draws a system line without a bubble', () => {
    expect(messageFromItem(item({ content: { kind: 'system', text: 'Bob joined' } }))).toMatchObject({ text: 'Bob joined', messageType: 'ai' });
  });

  it('flattens reactions to emoji → account ids, and omits the field when there are none', () => {
    expect(messageFromItem(item({ reactions: [{ key: '👍', accountIds: ['a', 'b'] }] })).reactions).toEqual({ '👍': ['a', 'b'] });
    expect(messageFromItem(item()).reactions).toBeUndefined();
  });
});

describe('previewOf', () => {
  it('names what a row cannot quote', () => {
    expect(previewOf(undefined)).toBe('');
    expect(previewOf(item())).toBe('hello');
    expect(previewOf(item({ content: { kind: 'media', media: { kind: 'voice', filename: 'v', mime: 'audio/mp4', size: 1, ref: { conversationId: 'c', blobId: 'b' } } } }))).toBe('Voice message');
    expect(previewOf(item({ content: { kind: 'deleted' } }))).toBe(PLACEHOLDER_TEXT.deleted);
  });
});

describe('conversationFromView', () => {
  const view: ConversationView = {
    id: 'conv-1',
    kind: 'group',
    appId: 'allo',
    title: 'Family',
    memberAccountIds: ['acc-me', 'acc-a', 'acc-b'],
    myRole: 'owner',
    epoch: 4,
    joined: true,
    lastMessage: item(),
    unreadCount: 2,
    lastActivityAt: '2026-09-17T10:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
  };

  it('maps a group with its title, members and role', () => {
    expect(conversationFromView(view)).toEqual({
      id: 'conv-1',
      type: 'group',
      name: 'Family',
      lastMessage: 'hello',
      timestamp: '2026-09-17T10:00:00.000Z',
      unreadCount: 2,
      participants: [{ id: 'acc-me' }, { id: 'acc-a' }, { id: 'acc-b' }],
      groupName: 'Family',
      participantCount: 3,
      joined: true,
      myRole: 'owner',
    });
  });

  it('leaves a direct conversation unnamed: the people layer names it', () => {
    const dm = conversationFromView({ ...view, kind: 'dm', title: null, memberAccountIds: ['acc-me', 'acc-a'], myRole: 'member' });
    expect(dm.type).toBe('direct');
    expect(dm.name).toBe('');
    expect(dm.groupName).toBeUndefined();
    expect(dm.participantCount).toBeUndefined();
  });
});
