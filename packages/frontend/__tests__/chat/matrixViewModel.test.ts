import { toConversation, toMessage, type UnreadableEventLabels } from '@/lib/chat/matrixViewModel';
import type { AlloRoomSummary, AlloTimelineItem } from '@/lib/matrix/types';

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
    const conversation = toConversation(room({ unreadCount: 3, avatarUrl: 'mxc://a' }));

    expect(conversation).toMatchObject({
      id: '!room:allo.you',
      type: 'direct',
      name: 'Alice',
      unreadCount: 3,
      avatar: 'mxc://a',
    });
  });

  it('calls a room that is not a direct message a group', () => {
    expect(toConversation(room({ isDirect: false })).type).toBe('group');
  });

  it('falls back to the room id while the name has not synced', () => {
    // A blank row is worse than an ugly one: the user can still tell two
    // unnamed conversations apart by their ids, and cannot tell two blanks apart.
    expect(toConversation(room({ displayName: undefined })).name).toBe('!room:allo.you');
  });

  it('leaves the last message empty rather than inventing one', () => {
    // The port's room summary carries no latest event. Reading one would mean a
    // timeline open per room in the list.
    expect(toConversation(room()).lastMessage).toBe('');
  });

  it('leaves the timestamp empty rather than saying "now"', () => {
    // This is the mistake this test exists to prevent. `AlloRoomSummary` has no
    // activity time, and `new Date().toISOString()` would put the current time
    // beside every conversation in the app — including one nobody has touched in
    // a year. An empty string is what the formatter renders as nothing.
    expect(toConversation(room()).timestamp).toBe('');
  });

  it('leaves the conversation theme unset', () => {
    // Themes are to travel as an encrypted timeline event and nothing writes one
    // yet, so a Matrix conversation uses the app's theme.
    expect(toConversation(room()).theme).toBeUndefined();
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
