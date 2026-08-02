import {
  toEncryptionState,
  toRoomSummary,
  toSyncState,
  toTimelineItem,
  type RoomStateFields,
  type RoomSummaryFields,
  type TimelineEventFields,
} from '@/lib/matrix/web/translate';

/**
 * Translation from `matrix-js-sdk`'s model to Allo's view model.
 *
 * The two facts these cases exist to hold down are the two the design documents
 * name — that a room's encryption has three states and not two, and that an event
 * which cannot be decrypted is a row with a state of its own rather than a row
 * with no text — plus the one the web SDK makes easy to get wrong: a message the
 * user just sent has to keep its place in the list when the homeserver answers.
 *
 * Nothing here imports `matrix-js-sdk`. The objects below are the members each
 * function reads, which is all the real ones are used for.
 */

const VIEWER = '@viewer:allo.you';

function roomState(types: readonly string[]): RoomStateFields {
  return {
    getStateEvents: (eventType) => (types.includes(eventType) ? { type: eventType } : null),
  };
}

function room(overrides: Partial<RoomSummaryFields> = {}): RoomSummaryFields {
  return {
    roomId: '!room:allo.you',
    name: 'Kitchen',
    getMyMembership: () => 'join',
    getMxcAvatarUrl: () => 'mxc://allo.you/avatar',
    getUnreadNotificationCount: () => 3,
    hasEncryptionStateEvent: () => true,
    ...overrides,
  };
}

function event(overrides: Partial<TimelineEventFields> = {}): TimelineEventFields {
  return {
    getId: () => '$event',
    getTxnId: () => undefined,
    getSender: () => '@alice:allo.you',
    getType: () => 'm.room.message',
    getContent: () => ({ msgtype: 'm.text', body: 'hello' }),
    getTs: () => 1_700_000_000_000,
    isRedacted: () => false,
    replacingEvent: () => null,
    status: null,
    sender: { name: 'Alice' },
    ...overrides,
  };
}

describe('toSyncState', () => {
  it('reports the state before the loop has ever run as idle', () => {
    // What a caller subscribing before startSync() has to be told.
    expect(toSyncState(null)).toBe('idle');
  });

  it('maps every state the SDK can be in', () => {
    expect(toSyncState('PREPARED')).toBe('running');
    expect(toSyncState('SYNCING')).toBe('running');
    expect(toSyncState('ERROR')).toBe('error');
    expect(toSyncState('STOPPED')).toBe('terminated');
  });

  it('calls a dropped connection offline rather than an error', () => {
    // The SDK reaches ERROR only after failing repeatedly; until then it is
    // retrying, which is a different thing to tell the user.
    expect(toSyncState('CATCHUP')).toBe('offline');
    expect(toSyncState('RECONNECTING')).toBe('offline');
  });
});

describe('toEncryptionState', () => {
  it('reports a room with an encryption event as encrypted', () => {
    expect(toEncryptionState({ hasEncryptionStateEvent: () => true }, roomState([]))).toBe(
      'encrypted',
    );
  });

  it('reports a room whose state is known and carries no encryption event as unencrypted', () => {
    expect(
      toEncryptionState({ hasEncryptionStateEvent: () => false }, roomState(['m.room.create'])),
    ).toBe('unencrypted');
  });

  it('does not call a room unencrypted when its state has not arrived', () => {
    // The case that matters: right after a room is created the encryption event
    // has not come down sync, and answering "unencrypted" would hang an open
    // padlock off an encrypted room.
    expect(toEncryptionState({ hasEncryptionStateEvent: () => false }, roomState([]))).toBe(
      'unknown',
    );
  });

  it('does not call a room unencrypted when there is no state at all', () => {
    expect(toEncryptionState({ hasEncryptionStateEvent: () => false }, undefined)).toBe('unknown');
  });
});

describe('toRoomSummary', () => {
  it('reads a room the way the conversation list draws it', () => {
    expect(toRoomSummary(room(), roomState(['m.room.create']), true)).toEqual({
      roomId: '!room:allo.you',
      displayName: 'Kitchen',
      avatarUrl: 'mxc://allo.you/avatar',
      isDirect: true,
      membership: 'joined',
      encryption: 'encrypted',
      unreadCount: 3,
    });
  });

  it('maps every membership the port names', () => {
    const memberships = ['join', 'invite', 'leave', 'knock', 'ban'];
    const mapped = memberships.map(
      (membership) =>
        toRoomSummary(room({ getMyMembership: () => membership }), undefined, false)?.membership,
    );

    expect(mapped).toEqual(['joined', 'invited', 'left', 'knocked', 'banned']);
  });

  it('drops a room whose membership this version of Allo has no name for', () => {
    // `Membership` is an open string type. Reporting an unknown one as joined
    // would put a room the user is not in at the top of their conversations.
    expect(toRoomSummary(room({ getMyMembership: () => 'm.future.state' }), undefined, false)).toBe(
      undefined,
    );
  });

  it('treats a room with no name and no avatar as having neither', () => {
    const summary = toRoomSummary(
      room({ name: '', getMxcAvatarUrl: () => null }),
      undefined,
      false,
    );

    expect(summary?.displayName).toBe(undefined);
    expect(summary?.avatarUrl).toBe(undefined);
  });

  it('never reports a negative or fractional unread count', () => {
    const counts = [-1, Number.NaN, 1.5];
    const mapped = counts.map(
      (count) =>
        toRoomSummary(room({ getUnreadNotificationCount: () => count }), undefined, false)
          ?.unreadCount,
    );

    expect(mapped).toEqual([0, 0, 0]);
  });
});

describe('toTimelineItem', () => {
  it('reads a text message', () => {
    expect(toTimelineItem(event(), VIEWER)).toEqual({
      key: '$event',
      id: { kind: 'remote', eventId: '$event' },
      sender: '@alice:allo.you',
      senderDisplayName: 'Alice',
      sentAt: 1_700_000_000_000,
      isOwn: false,
      sendState: 'sent',
      content: { kind: 'text', body: 'hello', isEdited: false },
    });
  });

  it('knows which messages are the viewer’s own', () => {
    expect(toTimelineItem(event({ getSender: () => VIEWER }), VIEWER)?.isOwn).toBe(true);
  });

  it('leaves the sender nameless until the SDK has resolved one', () => {
    expect(toTimelineItem(event({ sender: null }), VIEWER)?.senderDisplayName).toBe(undefined);
  });

  it('reports an edited message with the content that replaced it', () => {
    // `getContent()` already answers with the replacement; what has to be carried
    // over is that it *was* replaced.
    const item = toTimelineItem(
      event({
        getContent: () => ({ msgtype: 'm.text', body: 'hello again' }),
        replacingEvent: () => ({}),
      }),
      VIEWER,
    );

    expect(item?.content).toEqual({ kind: 'text', body: 'hello again', isEdited: true });
  });

  describe('an event that cannot be read', () => {
    it('is a state of its own rather than a row with no text', () => {
      // A device that has just been set up sees this for every message sent
      // before it existed. "Arrived but cannot be read" and "did not arrive" are
      // different facts and the UI has to be able to tell them apart.
      expect(toTimelineItem(event({ getType: () => 'm.room.encrypted' }), VIEWER)?.content).toEqual(
        { kind: 'undecryptable' },
      );
    });

    it('carries no body even when the encrypted event has one', () => {
      const item = toTimelineItem(
        event({
          getType: () => 'm.room.encrypted',
          getContent: () => ({ msgtype: 'm.text', body: 'ciphertext leaked into content' }),
        }),
        VIEWER,
      );

      expect(item?.content).toEqual({ kind: 'undecryptable' });
    });

    it('is redacted rather than undecryptable once it has been redacted', () => {
      const item = toTimelineItem(
        event({ getType: () => 'm.room.encrypted', isRedacted: () => true }),
        VIEWER,
      );

      expect(item?.content).toEqual({ kind: 'redacted' });
    });
  });

  describe('an event Allo does not draw', () => {
    it('is reported as itself rather than dropped', () => {
      // A gap in a conversation should be visible instead of silent.
      expect(toTimelineItem(event({ getType: () => 'm.room.member' }), VIEWER)?.content).toEqual({
        kind: 'unsupported',
        description: 'm.room.member',
      });
    });

    it('names the message type when the message is not text', () => {
      // An image's body is its filename; drawing it as the message would be
      // worse than admitting the row is not drawable yet.
      const item = toTimelineItem(
        event({ getContent: () => ({ msgtype: 'm.image', body: 'holiday.jpg' }) }),
        VIEWER,
      );

      expect(item?.content).toEqual({
        kind: 'unsupported',
        description: 'm.room.message:m.image',
      });
    });

    it('refuses a text message whose body is not a string', () => {
      const item = toTimelineItem(
        event({ getContent: () => ({ msgtype: 'm.text', body: { evil: true } }) }),
        VIEWER,
      );

      expect(item?.content.kind).toBe('unsupported');
    });
  });

  describe('a message on its way out', () => {
    it('is addressed by its transaction id while it is sending', () => {
      const item = toTimelineItem(
        event({
          status: 'sending',
          getTxnId: () => 'm1700000000',
          // The SDK's placeholder until the homeserver answers.
          getId: () => '~!room:allo.you:m1700000000',
        }),
        VIEWER,
      );

      expect(item?.id).toEqual({ kind: 'local', transactionId: 'm1700000000' });
      expect(item?.sendState).toBe('pending');
    });

    it('keeps its place in the list when the homeserver answers', () => {
      // The row has to be one row that changes, not two rows that replace each
      // other: the key is what the list is keyed on, and the transaction id is
      // the only thing that survives the local echo becoming a remote event.
      const local = toTimelineItem(
        event({ status: 'sending', getTxnId: () => 'm1', getId: () => '~!room:allo.you:m1' }),
        VIEWER,
      );
      const remote = toTimelineItem(
        event({ status: 'sent', getTxnId: () => 'm1', getId: () => '$real' }),
        VIEWER,
      );

      expect(local?.key).toBe(remote?.key);
      expect(remote?.id).toEqual({ kind: 'remote', eventId: '$real' });
    });

    it('reports a send that failed as failed, and a cancelled one too', () => {
      const send = (status: 'not_sent' | 'cancelled'): string | undefined =>
        toTimelineItem(event({ status, getTxnId: () => 'm1' }), VIEWER)?.sendState;

      expect(send('not_sent')).toBe('failed');
      expect(send('cancelled')).toBe('failed');
    });
  });

  describe('an event that cannot be addressed', () => {
    it('is refused rather than given a made-up key', () => {
      // Two rows sharing a key is a list that reorders itself under the user.
      expect(toTimelineItem(event({ getId: () => undefined }), VIEWER)).toBe(undefined);
    });

    it('is refused when it has no sender', () => {
      expect(toTimelineItem(event({ getSender: () => undefined }), VIEWER)).toBe(undefined);
    });
  });
});
