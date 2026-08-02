import { toConversation, toMessage, type UnreadableEventLabels } from '@/lib/chat/matrixViewModel';
import type { AlloRoomPreview, AlloRoomSummary, AlloTimelineItem } from '@/lib/matrix/types';
import { formatConversationTimestamp } from '@/utils/dateUtils';

/**
 * The translation from what the port reports to what Allo's chat components
 * draw. Every gap between the two models shows up here, and this is where it is
 * pinned down so it cannot be closed by inventing a value.
 */

const LABELS: UnreadableEventLabels = {
  undecryptable: 'cannot be read on this device',
  redacted: 'was deleted',
  unsupported: (description) => `cannot show this yet (${description})`,
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
    ...overrides,
  };
}

describe('toConversation', () => {
  it('carries the room across as a direct conversation', () => {
    const conversation = toConversation(room({ unreadCount: 3, avatarUrl: 'mxc://a' }), LABELS);

    expect(conversation).toMatchObject({
      id: '!room:allo.you',
      type: 'direct',
      name: 'Alice',
      unreadCount: 3,
      avatar: 'mxc://a',
    });
  });

  it('calls a room that is not a direct message a group', () => {
    expect(toConversation(room({ isDirect: false }), LABELS).type).toBe('group');
  });

  it('falls back to the room id while the name has not synced', () => {
    // A blank row is worse than an ugly one: the user can still tell two
    // unnamed conversations apart by their ids, and cannot tell two blanks apart.
    expect(toConversation(room({ displayName: undefined }), LABELS).name).toBe('!room:allo.you');
  });

  it('shows the last message and the time it was sent', () => {
    const conversation = toConversation(
      room({ latestMessage: preview({ sentAt: 1_700_000_000_000 }) }),
      LABELS,
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
    const conversation = toConversation(room({ latestMessage: undefined }), LABELS);

    expect(conversation.timestamp).toBe('');
    expect(formatConversationTimestamp(conversation.timestamp)).toBe('');
  });

  it('leaves the preview empty when there is no message, rather than inventing one', () => {
    expect(toConversation(room({ latestMessage: undefined }), LABELS).lastMessage).toBe('');
  });

  it('says so when the last message cannot be read on this device', () => {
    // A row that went blank would read as a conversation nobody has written in.
    // A device set up today sees this for every conversation it joins.
    const conversation = toConversation(
      room({ latestMessage: preview({ content: { kind: 'undecryptable' } }) }),
      LABELS,
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
    );

    expect(new Date(conversation.timestamp).getTime()).toBe(1_600_000_000_000);
  });

  it('says so when the last message was deleted, and when it cannot be drawn', () => {
    expect(
      toConversation(room({ latestMessage: preview({ content: { kind: 'redacted' } }) }), LABELS)
        .lastMessage,
    ).toBe('was deleted');
    expect(
      toConversation(
        room({
          latestMessage: preview({ content: { kind: 'unsupported', description: 'm.image' } }),
        }),
        LABELS,
      ).lastMessage,
    ).toBe('cannot show this yet (m.image)');
  });

  it('marks an invitation as one', () => {
    // An invitation is in the list because the port's definition of a
    // conversation is everything the viewer has not left. It is not a
    // conversation yet — there is nothing to read in it until it is accepted —
    // and the screen cannot tell unless this says so.
    expect(toConversation(room({ membership: 'invited' }), LABELS).isInvitation).toBe(true);
  });

  it('does not mark a conversation the viewer has joined as an invitation', () => {
    expect(toConversation(room({ membership: 'joined' }), LABELS).isInvitation).toBe(false);
  });

  it('leaves the conversation theme unset', () => {
    // Themes are to travel as an encrypted timeline event and nothing writes one
    // yet, so a Matrix conversation uses the app's theme.
    expect(toConversation(room(), LABELS).theme).toBeUndefined();
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

  it('does not claim a failed send reached the homeserver', () => {
    // The bubble has no failed state, so this settles for the clock. What it
    // must never do is report `sent`, which draws the tick that tells the user
    // the message arrived.
    const message = toMessage(
      event({ isOwn: true, sendState: 'failed' }),
      '!room:allo.you',
      LABELS,
    );

    expect(message.readStatus).not.toBe('sent');
    expect(message.readStatus).toBe('pending');
  });
});
