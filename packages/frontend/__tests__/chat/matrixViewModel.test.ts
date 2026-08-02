import { toConversation, toMessage, type UnreadableEventLabels } from '@/lib/chat/matrixViewModel';
import type {
  AlloMediaContent,
  AlloRoomPreview,
  AlloRoomSummary,
  AlloTimelineItem,
} from '@/lib/matrix/types';
import { formatConversationTimestamp } from '@/utils/dateUtils';

/**
 * The translation from what the port reports to what Allo's chat components
 * draw. Every gap between the two models shows up here, and this is where it is
 * pinned down so it cannot be closed by inventing a value.
 */

const LABELS: UnreadableEventLabels = {
  undecryptable: 'cannot be read on this device',
  redacted: 'was deleted',
  expired: 'no longer shown here',
  unsupported: (description) => `cannot show this yet (${description})`,
  mediaPreview: (kind) => `a ${kind}`,
};

function room(overrides: Partial<AlloRoomSummary> = {}): AlloRoomSummary {
  return {
    roomId: '!room:allo.you',
    displayName: 'Alice',
    avatarUrl: undefined,
    isDirect: true,
    membership: 'joined',
    encryption: 'encrypted',
    unreadCount: 0,
    latestMessage: undefined,
    ...overrides,
  };
}

function preview(overrides: Partial<AlloRoomPreview> = {}): AlloRoomPreview {
  return {
    sentAt: 1_700_000_000_000,
    sender: '@alice:allo.you',
    senderDisplayName: 'Alice',
    isOwn: false,
    content: { kind: 'text', body: 'see you there', isEdited: false },
    ...overrides,
  };
}

function event(overrides: Partial<AlloTimelineItem> = {}): AlloTimelineItem {
  return {
    key: 'row-1',
    id: { kind: 'remote', eventId: '$one' },
    sender: '@alice:allo.you',
    senderDisplayName: 'Alice',
    sentAt: 1_700_000_000_000,
    isOwn: false,
    sendState: 'sent',
    content: { kind: 'text', body: 'hello', isEdited: false },
    reactions: [],
    isReadByOthers: false,
    ...overrides,
  };
}

describe('toConversation', () => {
  it('carries the room across as a direct conversation', () => {
    const conversation = toConversation(room({ unreadCount: 3, avatarUrl: 'mxc://a' }), LABELS, false);

    expect(conversation).toMatchObject({
      id: '!room:allo.you',
      type: 'direct',
      name: 'Alice',
      unreadCount: 3,
      avatar: 'mxc://a',
    });
  });

  it('calls a room that is not a direct message a group', () => {
    expect(toConversation(room({ isDirect: false }), LABELS, false).type).toBe('group');
  });

  it('falls back to the room id while the name has not synced', () => {
    // A blank row is worse than an ugly one: the user can still tell two
    // unnamed conversations apart by their ids, and cannot tell two blanks apart.
    expect(toConversation(room({ displayName: undefined }), LABELS, false).name).toBe('!room:allo.you');
  });

  it('shows the last message and the time it was sent', () => {
    const conversation = toConversation(
      room({ latestMessage: preview({ sentAt: 1_700_000_000_000 }) }),
      LABELS,
      false,
    );

    expect(conversation.lastMessage).toBe('see you there');
    expect(new Date(conversation.timestamp).getTime()).toBe(1_700_000_000_000);
  });

  it('leaves the timestamp empty rather than saying "now"', () => {
    // This is the mistake this test exists to prevent. A room whose latest
    // message this device does not know has no activity time, and the current
    // time would put "now" beside every conversation in the app — including one
    // nobody has touched in a year. An empty string is what the formatter
    // renders as nothing.
    const conversation = toConversation(room({ latestMessage: undefined }), LABELS, false);

    expect(conversation.timestamp).toBe('');
    expect(formatConversationTimestamp(conversation.timestamp)).toBe('');
  });

  it('leaves the preview empty when there is no message, rather than inventing one', () => {
    expect(toConversation(room({ latestMessage: undefined }), LABELS, false).lastMessage).toBe('');
  });

  it('says so when the last message cannot be read on this device', () => {
    // A row that went blank would read as a conversation nobody has written in.
    // A device set up today sees this for every conversation it joins.
    const conversation = toConversation(
      room({ latestMessage: preview({ content: { kind: 'undecryptable' } }) }),
      LABELS,
      false,
    );

    expect(conversation.lastMessage).toBe('cannot be read on this device');
    expect(conversation.lastMessage).not.toBe('');
  });

  it('still shows a time for a message it cannot read', () => {
    // The time comes from the event, which arrived; only its content did not.
    const conversation = toConversation(
      room({
        latestMessage: preview({ content: { kind: 'undecryptable' }, sentAt: 1_600_000_000_000 }),
      }),
      LABELS,
      false,
    );

    expect(new Date(conversation.timestamp).getTime()).toBe(1_600_000_000_000);
  });

  it('says so when the last message was deleted, and when it cannot be drawn', () => {
    expect(
      toConversation(
        room({ latestMessage: preview({ content: { kind: 'redacted' } }) }),
        LABELS,
        false,
      ).lastMessage,
    ).toBe('was deleted');
    expect(
      toConversation(
        room({
          latestMessage: preview({ content: { kind: 'unsupported', description: 'm.image' } }),
        }),
        LABELS,
        false,
      ).lastMessage,
    ).toBe('cannot show this yet (m.image)');
  });

  it('marks an invitation as one', () => {
    // An invitation is in the list because the port's definition of a
    // conversation is everything the viewer has not left. It is not a
    // conversation yet — there is nothing to read in it until it is accepted —
    // and the screen cannot tell unless this says so.
    expect(toConversation(room({ membership: 'invited' }), LABELS, false).isInvitation).toBe(true);
  });

  it('does not mark a conversation the viewer has joined as an invitation', () => {
    expect(toConversation(room({ membership: 'joined' }), LABELS, false).isInvitation).toBe(false);
  });

  it('marks a conversation whose messages disappear', () => {
    // An ephemeral conversation is identical to an ordinary one until its
    // messages start vanishing, which is after the moment anybody could have
    // decided differently. The row has to say so.
    expect(toConversation(room(), LABELS, true).isEphemeral).toBe(true);
  });

  it('does not mark an ordinary conversation', () => {
    expect(toConversation(room(), LABELS, false).isEphemeral).toBe(false);
  });

  it('leaves the conversation theme unset', () => {
    // Themes are to travel as an encrypted timeline event and nothing writes one
    // yet, so a Matrix conversation uses the app's theme.
    expect(toConversation(room(), LABELS, false).theme).toBeUndefined();
  });
});

describe('toMessage', () => {
  it('carries a text message across', () => {
    const message = toMessage(event(), '!room:allo.you', LABELS);

    expect(message).toMatchObject({
      id: 'row-1',
      text: 'hello',
      senderId: '@alice:allo.you',
      senderName: 'Alice',
      isSent: false,
      conversationId: '!room:allo.you',
    });
    expect(message.timestamp.getTime()).toBe(1_700_000_000_000);
  });

  it('keys the row by the port key and not the event id', () => {
    // The key is what survives a message the user just sent turning from a local
    // echo into an event with an id. Keying by event id would remount the row at
    // exactly the moment it must not move.
    const message = toMessage(
      event({ key: 'row-7', id: { kind: 'local', transactionId: 'txn-1' } }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.id).toBe('row-7');
  });

  it('says an undecryptable event arrived and cannot be read', () => {
    // An event the SDK could not decrypt carries no body at all. Rendering it as
    // an empty bubble makes "arrived but unreadable" look like "sent nothing",
    // and a device set up today sees it for every message older than itself.
    const message = toMessage(
      event({ content: { kind: 'undecryptable' } }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.text).toBe('cannot be read on this device');
    expect(message.text).not.toBe('');
    expect(message.isEncrypted).toBe(true);
  });

  it('says a redacted event was deleted', () => {
    const message = toMessage(
      event({ content: { kind: 'redacted' } }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.text).toBe('was deleted');
    // Not the same fact as an undecryptable one: there is nothing to read, not
    // something unreadable.
    expect(message.isEncrypted).toBe(false);
  });

  it('says an expired message is no longer shown, and not that it was deleted', () => {
    // Two different facts, and the weaker one must not borrow the stronger one's
    // words. "Deleted" says the homeserver no longer has it; "no longer shown
    // here" says only that this device has stopped drawing it, which is all that
    // is true until whoever sent it redacts it.
    const message = toMessage(
      event({ content: { kind: 'expired' } }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.text).toBe('no longer shown here');
    expect(message.text).not.toBe('was deleted');
    expect(message.media).toBeUndefined();
    expect(message.attachment).toBeUndefined();
  });

  it('names the kind of event it cannot draw', () => {
    const message = toMessage(
      event({ content: { kind: 'unsupported', description: 'm.room.member' } }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.text).toBe('cannot show this yet (m.room.member)');
  });

  it('gives no send status to a message the viewer did not send', () => {
    // The bubble draws a status only for the sender's own messages; reporting
    // one for anyone else's would put a tick under a message the viewer received.
    expect(toMessage(event({ isOwn: false }), '!room:allo.you', LABELS).readStatus).toBeUndefined();
  });

  it('shows a clock while a message the viewer sent is still on its way', () => {
    const message = toMessage(
      event({ isOwn: true, sendState: 'pending' }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.readStatus).toBe('pending');
  });

  it('shows a tick once the homeserver has the message', () => {
    const message = toMessage(event({ isOwn: true, sendState: 'sent' }), '!room:allo.you', LABELS);

    expect(message.readStatus).toBe('sent');
  });

  it('draws a failed send as an error and not as the clock', () => {
    // The mistake this holds down. `failed` and `pending` look the same to a
    // switch that only tests for `sent`, and the two mean opposite things: the
    // clock says "still going", and nothing is still going. On the web nothing
    // retries at all, so a clock there is a message the user believes is on its
    // way and which no longer exists.
    const message = toMessage(
      event({ isOwn: true, sendState: 'failed' }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.readStatus).toBe('failed');
    expect(message.readStatus).not.toBe('pending');
    expect(message.readStatus).not.toBe('sent');
  });

  it('shows two ticks once somebody else has read the message', () => {
    const message = toMessage(
      event({ isOwn: true, sendState: 'sent', isReadByOthers: true }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.readStatus).toBe('read');
  });

  it('never reports a message as delivered', () => {
    // Matrix has no delivery receipt: there is no event for "it reached their
    // device". `delivered` draws a tick that would mean something Allo cannot
    // know, so no combination of states may reach it.
    const states = (['pending', 'sent', 'failed'] as const).flatMap((sendState) =>
      [false, true].map(
        (isReadByOthers) =>
          toMessage(event({ isOwn: true, sendState, isReadByOthers }), '!room:allo.you', LABELS)
            .readStatus,
      ),
    );

    expect(states).not.toContain('delivered');
  });

  it('reports an edited message as edited', () => {
    const message = toMessage(
      event({ content: { kind: 'text', body: 'fixed', isEdited: true } }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.isEdited).toBe(true);
    expect(message.text).toBe('fixed');
  });

  it('does not call a redacted message an edited one', () => {
    // Both arrive as "the body you had is not the body now", and only one of them
    // is a correction the sender made.
    const message = toMessage(
      event({ content: { kind: 'redacted' } }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.isEdited).toBe(false);
  });

  it('carries reactions across as emoji to senders', () => {
    const message = toMessage(
      event({
        reactions: [
          { key: '👍', senders: ['@alice:allo.you', '@bob:allo.you'] },
          { key: '❤️', senders: ['@bob:allo.you'] },
        ],
      }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.reactions).toEqual({
      '👍': ['@alice:allo.you', '@bob:allo.you'],
      '❤️': ['@bob:allo.you'],
    });
  });

  it('leaves reactions unset when nobody has reacted', () => {
    expect(toMessage(event(), '!room:allo.you', LABELS).reactions).toBeUndefined();
  });
});

describe('an attachment, as a message', () => {
  function media(overrides: Partial<AlloMediaContent> = {}): AlloMediaContent {
    return {
      kind: 'image',
      filename: 'holiday.jpg',
      caption: undefined,
      source: 'ref:full',
      thumbnail: 'ref:thumb',
      width: 3024,
      height: 4032,
      durationMs: undefined,
      size: 2_400_000,
      ...overrides,
    };
  }

  function messageWith(overrides: Partial<AlloMediaContent> = {}) {
    return toMessage(
      event({ content: { kind: 'media', media: media(overrides) } }),
      '!room:allo.you',
      LABELS,
    );
  }

  it('draws the sender\'s thumbnail rather than the original', () => {
    // A bubble is 250pt wide and the original is a phone camera's full
    // resolution. In an encrypted room the sender's thumbnail is the only
    // smaller copy that exists: a homeserver cannot resize what it cannot read.
    expect(messageWith().media).toEqual([
      {
        id: 'ref:thumb',
        type: 'image',
        fullSizeId: 'ref:full',
        filename: 'holiday.jpg',
      },
    ]);
  });

  it('keeps the original beside the thumbnail, or the viewer has nothing to open', () => {
    // The whole reason `fullSizeId` exists. The bubble draws the small copy and
    // the ref for the big one is otherwise gone by the time anything can ask —
    // which is exactly why tapping an attachment used to do nothing.
    expect(messageWith().media?.[0].fullSizeId).toBe('ref:full');
  });

  it('falls back to the original when the sender made no thumbnail', () => {
    expect(messageWith({ thumbnail: undefined }).media).toEqual([
      {
        id: 'ref:full',
        type: 'image',
        fullSizeId: undefined,
        filename: 'holiday.jpg',
      },
    ]);
  });

  it('claims no larger copy when the row is already drawing the original', () => {
    // Set unconditionally, `fullSizeId` would send the viewer to download bytes
    // it already has.
    expect(messageWith({ thumbnail: undefined }).media?.[0].fullSizeId).toBeUndefined();
  });

  it('carries the port media ref as the id, because that is what resolves it', () => {
    // `MediaCarousel` calls `getMediaUrl(item.id, …)`, and on the Matrix path
    // that resolver is the media cache, which takes a ref. An id of Allo's own
    // invention would resolve to nothing.
    expect(messageWith().media?.[0].id).toBe('ref:thumb');
  });

  it('says nothing in the bubble for a picture with no caption', () => {
    // The bubble *is* the picture. A filename printed under it is noise.
    expect(messageWith().text).toBe('');
  });

  it("says the sender's words when there are some", () => {
    expect(messageWith({ caption: 'look at this' }).text).toBe('look at this');
  });

  it('draws a video as a video', () => {
    expect(messageWith({ kind: 'video' }).media).toEqual([
      {
        id: 'ref:thumb',
        type: 'video',
        fullSizeId: 'ref:full',
        filename: 'holiday.jpg',
      },
    ]);
  });

  it.each(['audio', 'voice', 'file'] as const)(
    'gives the carousel no %s, which it cannot draw',
    (kind) => {
      // `MediaCarousel` renders images and a still frame for videos and nothing
      // else. Handing it one of these would produce an empty bubble.
      const message = messageWith({ kind, filename: 'voice.m4a', thumbnail: undefined });

      expect(message.media).toBeUndefined();
    },
  );

  it.each(['audio', 'voice', 'file'] as const)(
    'hands a %s to the player or the file row instead, with what it needs',
    (kind) => {
      const message = messageWith({
        kind,
        filename: 'voice.m4a',
        thumbnail: undefined,
        durationMs: 7_400,
        size: 68_000,
      });

      expect(message.attachment).toEqual({
        kind,
        source: 'ref:full',
        filename: 'voice.m4a',
        size: 68_000,
        durationMs: 7_400,
      });
    },
  );

  it('points an attachment at the original and never at the thumbnail', () => {
    // Unlike the carousel. There is no smaller version of a recording, and
    // playing a thumbnail of one plays nothing.
    const message = messageWith({ kind: 'voice', thumbnail: 'ref:thumb' });

    expect(message.attachment?.source).toBe('ref:full');
  });

  it.each(['image', 'video'] as const)(
    'gives no attachment for a %s, which the carousel already draws',
    (kind) => {
      // The two are exclusive by construction. A message carrying both would
      // draw the same file twice, once as a picture and once as a file row.
      expect(messageWith({ kind }).attachment).toBeUndefined();
    },
  );

  it('says nothing in the bubble for a voice note either', () => {
    // The player is the bubble, exactly as the picture is. Before the player
    // existed this said "Attachment: voice.m4a", which was the app admitting it
    // could not show the thing.
    expect(messageWith({ kind: 'voice', filename: 'voice.m4a' }).text).toBe('');
  });

  it('lets a caption speak for an attachment it cannot draw either', () => {
    const message = messageWith({ kind: 'file', caption: 'the contract' });

    expect(message.text).toBe('the contract');
  });
});

describe('an attachment, as a conversation row', () => {
  function rowFor(overrides: Partial<AlloMediaContent>) {
    return toConversation(
      room({
        latestMessage: preview({
          content: {
            kind: 'media',
            media: {
              kind: 'image',
              filename: 'holiday.jpg',
              caption: undefined,
              source: 'ref:full',
              thumbnail: undefined,
              width: undefined,
              height: undefined,
              durationMs: undefined,
              size: undefined,
              ...overrides,
            },
          },
        }),
      }),
      LABELS,
      false,
    );
  }

  it('names the kind rather than going blank', () => {
    // The opposite of the bubble, and deliberately so: an empty preview reads
    // as a conversation nobody has written in.
    expect(rowFor({ kind: 'image' }).lastMessage).toBe('a image');
    expect(rowFor({ kind: 'voice' }).lastMessage).toBe('a voice');
  });

  it('prefers the caption, which is what the sender actually wrote', () => {
    expect(rowFor({ caption: 'look at this' }).lastMessage).toBe('look at this');
  });

  it('still shows the time, because a picture is a message', () => {
    expect(rowFor({ kind: 'image' }).timestamp).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });
});
