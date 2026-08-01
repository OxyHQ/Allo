import {
  EncryptedMessage,
  EncryptionState,
  EventOrTransactionId,
  EventSendState,
  Membership,
  MessageLikeEventType,
  MessageType,
  MsgLikeKind,
  ProfileDetails,
  QueueWedgeError,
  SyncServiceState,
  TimelineItemContent,
} from '@unomed/react-native-matrix-sdk';
import type { EventTimelineItem, TimelineItemContent as SdkTimelineItemContent } from '@unomed/react-native-matrix-sdk';

import {
  toEncryptionState,
  toRoomSummary,
  toSyncState,
  toTimelineItem,
  type RoomSummaryFields,
  type TimelineEventFields,
} from '@/lib/matrix/native/translate';

jest.mock('@unomed/react-native-matrix-sdk');

/**
 * Translation from the binding's model to Allo's view model.
 *
 * The two facts these cases exist to hold down are the two the design documents
 * call out by name: that a room's encryption has three states and not two, and
 * that an event which cannot be decrypted is a row with a state of its own rather
 * than a row with no text.
 */

function textContent(body: string, isEdited = false): SdkTimelineItemContent {
  return new TimelineItemContent.MsgLike({
    content: {
      kind: new MsgLikeKind.Message({
        content: {
          msgType: new MessageType.Text({ content: { body } }),
          body,
          isEdited,
        },
      }),
      reactions: [],
    },
  });
}

function event(overrides: Partial<TimelineEventFields> = {}): TimelineEventFields {
  return {
    eventOrTransactionId: new EventOrTransactionId.EventId({ eventId: '$event' }),
    sender: '@alice:allo.oxy.so',
    senderProfile: new ProfileDetails.Unavailable(),
    content: textContent('hello'),
    timestamp: 1_700_000_000_000n,
    isOwn: false,
    localSendState: undefined,
    ...overrides,
  };
}

function roomInfo(overrides: Partial<RoomSummaryFields> = {}): RoomSummaryFields {
  return {
    id: '!room:allo.oxy.so',
    displayName: 'Bea',
    avatarUrl: 'mxc://allo.oxy.so/avatar',
    isDirect: true,
    membership: Membership.Joined,
    encryptionState: EncryptionState.Encrypted,
    numUnreadMessages: 0n,
    ...overrides,
  };
}

describe('toEncryptionState', () => {
  it('keeps "not known yet" apart from "not encrypted"', () => {
    // The whole reason this is not a boolean. `Unknown` is what the SDK reports
    // for a room whose `m.room.encryption` has not come down sync yet — which is
    // the normal state of a room that was just created. Reporting it as
    // unencrypted draws an open padlock on an encrypted conversation.
    expect(toEncryptionState(EncryptionState.Unknown)).toBe('unknown');
    expect(toEncryptionState(EncryptionState.NotEncrypted)).toBe('unencrypted');
    expect(toEncryptionState(EncryptionState.Encrypted)).toBe('encrypted');
  });
});

describe('toSyncState', () => {
  it('names every state the sync service can be in', () => {
    expect(toSyncState(SyncServiceState.Idle)).toBe('idle');
    expect(toSyncState(SyncServiceState.Running)).toBe('running');
    expect(toSyncState(SyncServiceState.Terminated)).toBe('terminated');
    expect(toSyncState(SyncServiceState.Error)).toBe('error');
    expect(toSyncState(SyncServiceState.Offline)).toBe('offline');
  });
});

describe('toRoomSummary', () => {
  it('carries the fields the conversation list draws', () => {
    expect(toRoomSummary(roomInfo({ numUnreadMessages: 3n }))).toEqual({
      roomId: '!room:allo.oxy.so',
      displayName: 'Bea',
      avatarUrl: 'mxc://allo.oxy.so/avatar',
      isDirect: true,
      membership: 'joined',
      encryption: 'encrypted',
      unreadCount: 3,
    });
  });

  it('passes an undetermined encryption state through instead of guessing', () => {
    expect(
      toRoomSummary(roomInfo({ encryptionState: EncryptionState.Unknown })).encryption,
    ).toBe('unknown');
  });

  it('names every membership', () => {
    const membershipOf = (membership: Membership): string =>
      toRoomSummary(roomInfo({ membership })).membership;

    expect(membershipOf(Membership.Invited)).toBe('invited');
    expect(membershipOf(Membership.Joined)).toBe('joined');
    expect(membershipOf(Membership.Left)).toBe('left');
    expect(membershipOf(Membership.Knocked)).toBe('knocked');
    expect(membershipOf(Membership.Banned)).toBe('banned');
  });

  it('reads an unread count that arrives as a bigint', () => {
    expect(toRoomSummary(roomInfo({ numUnreadMessages: 42n })).unreadCount).toBe(42);
  });
});

describe('toTimelineItem', () => {
  describe('content', () => {
    it('reads a text message', () => {
      expect(toTimelineItem('row-1', event({ content: textContent('hola', true) })).content)
        .toEqual({ kind: 'text', body: 'hola', isEdited: true });
    });

    it('reports an event that cannot be decrypted as a state of its own', () => {
      // An `UnableToDecrypt` event carries no body at all, so there is nothing to
      // fall back on: the row has to say "arrived, unreadable" rather than be
      // dropped or shown blank. This is what a freshly set-up device sees for
      // every message sent before it existed.
      const item = toTimelineItem(
        'row-1',
        event({
          content: new TimelineItemContent.MsgLike({
            content: {
              kind: new MsgLikeKind.UnableToDecrypt({
                msg: new EncryptedMessage.Unknown(),
              }),
              reactions: [],
            },
          }),
        }),
      );

      expect(item.content).toEqual({ kind: 'undecryptable' });
      // And it is a full row: the envelope survives even though the content did
      // not, which is what lets the UI place it in the right spot.
      expect(item.sender).toBe('@alice:allo.oxy.so');
      expect(item.sentAt).toBe(1_700_000_000_000);
    });

    it('reports a redacted event as redacted, not as empty text', () => {
      expect(
        toTimelineItem(
          'row-1',
          event({
            content: new TimelineItemContent.MsgLike({
              content: { kind: new MsgLikeKind.Redacted(), reactions: [] },
            }),
          }),
        ).content,
      ).toEqual({ kind: 'redacted' });
    });

    it('refuses to draw a non-text message as text', () => {
      // A notice has a perfectly readable `body`, and so does an image — an
      // image's is its filename. Treating "has a body" as "is text" is how a
      // conversation ends up showing "IMG_0421.jpg" as somebody's message.
      const content = new TimelineItemContent.MsgLike({
        content: {
          kind: new MsgLikeKind.Message({
            content: {
              msgType: new MessageType.Notice({ content: { body: 'bridge notice' } }),
              body: 'bridge notice',
              isEdited: false,
            },
          }),
          reactions: [],
        },
      });

      expect(toTimelineItem('row-1', event({ content })).content).toEqual({
        kind: 'unsupported',
        description: 'm.room.message:Notice',
      });
    });

    it('reports a non-message event rather than dropping it', () => {
      // Dropped rows leave a gap that looks like lost messages. Naming them keeps
      // the gap visible.
      const content = new TimelineItemContent.RoomMembership({
        userId: '@bea:allo.oxy.so',
        userDisplayName: undefined,
        change: undefined,
        reason: undefined,
      });

      expect(toTimelineItem('row-1', event({ content })).content).toEqual({
        kind: 'unsupported',
        description: 'RoomMembership',
      });
    });

    it('reports a message-like event that is not a message as unsupported', () => {
      const content = new TimelineItemContent.MsgLike({
        content: {
          kind: new MsgLikeKind.Other({
            eventType: new MessageLikeEventType.Reaction(),
          }),
          reactions: [],
        },
      });

      expect(toTimelineItem('row-1', event({ content })).content).toEqual({
        kind: 'unsupported',
        description: 'Other',
      });
    });
  });

  describe('identity', () => {
    it('keeps the row key it was given, which is not the event id', () => {
      // The key is the SDK's list identity, and it is what survives a local echo
      // becoming a remote event. Using the event id would change the key at that
      // moment and make React redraw the message as a new row.
      expect(toTimelineItem('row-7', event()).key).toBe('row-7');
    });

    it('distinguishes an event the server has acknowledged from one it has not', () => {
      expect(toTimelineItem('row-1', event()).id).toEqual({
        kind: 'remote',
        eventId: '$event',
      });

      expect(
        toTimelineItem(
          'row-1',
          event({
            eventOrTransactionId: new EventOrTransactionId.TransactionId({
              transactionId: 'txn-1',
            }),
          }),
        ).id,
      ).toEqual({ kind: 'local', transactionId: 'txn-1' });
    });
  });

  describe('send state', () => {
    const sendStateOf = (localSendState: EventTimelineItem['localSendState']): string =>
      toTimelineItem('row-1', event({ localSendState })).sendState;

    it('treats an event with no local state as one the server already has', () => {
      // Local send state only exists while an event of ours is on its way out.
      expect(sendStateOf(undefined)).toBe('sent');
    });

    it('reads the states of an event on its way out', () => {
      expect(sendStateOf(new EventSendState.NotSentYet({ progress: undefined }))).toBe(
        'pending',
      );
      expect(
        sendStateOf(
          new EventSendState.SendingFailed({
            error: new QueueWedgeError.GenericApiError({ msg: 'nope' }),
            isRecoverable: false,
          }),
        ),
      ).toBe('failed');
      expect(sendStateOf(new EventSendState.Sent({ eventId: '$event' }))).toBe('sent');
    });
  });

  describe('sender', () => {
    it('takes the display name once the profile has resolved', () => {
      expect(
        toTimelineItem(
          'row-1',
          event({
            senderProfile: new ProfileDetails.Ready({
              displayName: 'Alice',
              displayNameAmbiguous: false,
              avatarUrl: undefined,
            }),
          }),
        ).senderDisplayName,
      ).toBe('Alice');
    });

    it('has no display name while the profile is still unresolved', () => {
      expect(
        toTimelineItem('row-1', event({ senderProfile: new ProfileDetails.Pending() }))
          .senderDisplayName,
      ).toBeUndefined();
      expect(toTimelineItem('row-1', event()).senderDisplayName).toBeUndefined();
    });
  });

  it('reads a timestamp that arrives as a bigint', () => {
    expect(toTimelineItem('row-1', event({ timestamp: 1_234_567_890_123n })).sentAt).toBe(
      1_234_567_890_123,
    );
  });
});
